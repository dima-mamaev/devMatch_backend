export function clearAllLocalStorage(): void {
  if (typeof window === "undefined") return;

  try {
    localStorage.clear();
  } catch {
  }
}
