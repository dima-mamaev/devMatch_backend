export const SENIORITY_YEARS: Record<string, string> = {
  junior: "0-2 yrs",
  mid: "2-4 yrs",
  senior: "4-8 yrs",
  lead: "8-12 yrs",
  principal: "12+ yrs",
};

export function formatSeniorityLevel(level: string): string {
  const years = SENIORITY_YEARS[level.toLowerCase()];
  return years ? `${years} exp` : level;
}
