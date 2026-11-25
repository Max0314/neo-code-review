"""Calculate local review estimates from findings already adjudicated by the reviewer."""
import json
import math
import sys
from pathlib import Path

BASELINE_PATH = Path(__file__).resolve().parents[1] / "references" / "ordinary-baseline.json"
FILE_ACTIONS = {"review_score", "review_no_score", "skip", "unknown"}
OCR_LEVELS = {
    "blocker": ("blocker", "critical", "fatal"),
    "severe": ("severe", "high", "error"),
    "general": ("general", "medium", "warning"),
    "hint": ("hint", "low", "remind"),
}
OCR_LEVEL_BY_NAME = {
    alias: level for level, aliases in OCR_LEVELS.items() for alias in aliases
}


def flag(data, key):
    value = data[key]
    if type(value) is not bool:
        raise ValueError(f"{key} must be a boolean")
    return value


def entries(data, key):
    value = data[key]
    if not isinstance(value, list):
        raise ValueError(f"{key} must be an array")
    return value


def unique_text(data, key, seen):
    value = data[key]
    if not isinstance(value, str) or not value.strip() or value in seen:
        raise ValueError(f"{key} must be nonempty and unique")
    seen.add(value)
    return value


def score_integer(value, name):
    if type(value) is not int or not 0 <= value <= 100:
        raise ValueError(f"{name} must be an integer from 0 to 100")
    return value


def ordinary_deduction(finding, baseline, override, delete_guard):
    severity = finding["severity"]
    quality = finding["evidence_quality"]
    default_bounds = baseline["severity_bounds"][severity]
    bounds = override.get("severity_bounds", {}).get(severity, {})
    low = score_integer(bounds.get("min", default_bounds["min"]), "severity minimum")
    high = score_integer(bounds.get("max", default_bounds["max"]), "severity maximum")
    if low > high:
        raise ValueError("severity minimum cannot exceed the maximum")
    factor = override.get("evidence_factor", {}).get(quality, baseline["evidence_factor"][quality])
    if type(factor) not in (int, float) or not math.isfinite(factor) or factor <= 0:
        raise ValueError("evidence factor must be positive and finite")
    base = score_integer(finding.get("base_deduct", low), "base_deduct") or low
    adjusted = min(high, max(low, round(min(high, max(low, base)) * factor)))
    if delete_guard and severity in {"FATAL", "ERROR"}:
        return "WARNING", min(10, max(5, adjusted or 10))
    return severity, adjusted


def ordinary_score(review, baseline):
    override = review.get("score_policy", {})
    no_issue = score_integer(override.get("no_issue_score", baseline["no_issue_score"]), "no_issue_score")
    files = []
    scores = []
    scope_complete = flag(review, "scope_complete")
    paths, root_ids = set(), set()
    for file in entries(review, "files"):
        path = unique_text(file, "path", paths)
        action = file["action"]
        if action not in FILE_ACTIONS:
            raise ValueError(f"unknown file action: {action}")
        result = {"path": path, "action": action, "score": None, "deductions": []}
        files.append(result)
        if action == "unknown":
            scope_complete = False
        if action != "review_score":
            continue
        if not flag(file, "coverage_complete"):
            scope_complete = False
            continue
        delete_guard = flag(file, "delete_guard") if "delete_guard" in file else False
        for finding in entries(file, "findings"):
            root_id = unique_text(finding, "id", root_ids)
            severity, deduct = ordinary_deduction(finding, baseline, override, delete_guard)
            result["deductions"].append({"id": root_id, "severity": severity, "deduct": deduct})
        total = sum(item["deduct"] for item in result["deductions"])
        if not result["deductions"]:
            value = no_issue
        elif delete_guard:
            value = 100 - min(total, 10)
        else:
            value = max(0, min(94, 100 - total))
        result["score"] = value
        scores.append(value)
    score = None
    if not scope_complete:
        status = "incomplete"
    elif not scores:
        status = "no_scoreable_files"
    else:
        status = "available"
        # Round the nonnegative arithmetic mean half up, as the service does.
        score = (2 * sum(scores) + len(scores)) // (2 * len(scores))
    return {"status": status, "score": score, "files": files}


def ocr_score(review, scope_complete):
    counts = dict.fromkeys(OCR_LEVELS, 0)
    reasons = []
    if not flag(review, "coverage_complete") or not scope_complete:
        reasons.append("incomplete_coverage")
    if not flag(review, "independent_review_complete"):
        reasons.append("incomplete_independent_review")
    included, root_ids = [], set()
    for finding in entries(review, "findings"):
        root_id = unique_text(finding, "id", root_ids)
        classification = finding["classification"]
        if classification in {"needs_confirmation", "unfinished"}:
            if classification not in reasons:
                reasons.append(classification)
            continue
        if classification == "excluded":
            continue
        if classification != "code_supported":
            raise ValueError(f"unknown OCR classification: {classification}")
        attribution = finding["attribution"]
        if attribution in {"preexisting", "not_introduced", "unchanged"}:
            continue
        level = OCR_LEVEL_BY_NAME.get(finding.get("severity", "").lower())
        if attribution != "introduced" or not level:
            if "incomplete_score_basis" not in reasons:
                reasons.append("incomplete_score_basis")
            continue
        counts[level] += 1
        included.append({"id": root_id, "level": level})

    result = {"status": "unavailable", "score": None, "reasons": reasons, "counts": counts, "included": included}
    if reasons:
        return result
    blocker, severe, general, hint = (counts[level] for level in OCR_LEVELS)
    if blocker:
        deduct = 55 + min(10, 5 * (blocker - 1) + 3 * severe + min(2, general))
    elif severe:
        deduct = 35 + min(10, 5 * (severe - 1) + min(4, 2 * general))
    elif general:
        deduct = 8 + min(4, 2 * (general - 1))
    else:
        deduct = 6 if hint else 5
    result.update(status="available", score=100 - deduct, deduction=deduct)
    return result


def main():
    try:
        if len(sys.argv) > 2:
            raise ValueError("usage: score_review.py [input.json]")
        source = Path(sys.argv[1]).read_bytes() if len(sys.argv) == 2 else sys.stdin.buffer.read()
        review = json.loads(source)
        baseline = json.loads(BASELINE_PATH.read_text(encoding="utf-8"))["score_policy"]
        result = {"ordinary": ordinary_score(review, baseline)}
        if "ocr" in review:
            result["ocr"] = ocr_score(review["ocr"], flag(review, "scope_complete"))
        print(json.dumps(result, ensure_ascii=True, indent=2))
    except (OSError, ValueError, TypeError, KeyError, AttributeError, OverflowError) as error:
        print(f"Invalid review scoring input: {error}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
