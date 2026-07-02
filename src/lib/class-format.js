export function formatGrade(grade) {
    return String(grade ?? "").replace(/^class\s+/i, "").trim();
}

export function formatClassName(cls) {
    if (!cls)
        return null;
    const grade = formatGrade(cls.grade);
    return [grade, cls.section].filter(Boolean).join("-");
}
