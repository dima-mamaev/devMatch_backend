/**
 * localStorage utilities for shortlist management for non-authenticated users.
 * Allows users to save developers to a local shortlist before signing in.
 */

const STORAGE_KEY = "devmatch_local_shortlist";
function isLocalStorageAvailable(): boolean {
  try {
    const testKey = "__test__";
    localStorage.setItem(testKey, testKey);
    localStorage.removeItem(testKey);
    return true;
  } catch {
    return false;
  }
}
export function getLocalShortlist(): string[] {
  if (!isLocalStorageAvailable()) {
    return [];
  }
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) {
      return [];
    }
    const parsed = JSON.parse(stored);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((id): id is string => typeof id === "string");
  } catch {
    return [];
  }
}
export function addToLocalShortlist(developerId: string): boolean {
  if (!isLocalStorageAvailable()) {
    return false;
  }
  try {
    const current = getLocalShortlist();
    if (current.includes(developerId)) {
      return false;
    }
    const updated = [...current, developerId];
    localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
    return true;
  } catch {
    return false;
  }
}
export function removeFromLocalShortlist(developerId: string): void {
  if (!isLocalStorageAvailable()) {
    return;
  }

  try {
    const current = getLocalShortlist();
    const updated = current.filter((id) => id !== developerId);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
  } catch {
  }
}
export function isInLocalShortlist(developerId: string): boolean {
  const current = getLocalShortlist();
  return current.includes(developerId);
}
export function clearLocalShortlist(): void {
  if (!isLocalStorageAvailable()) {
    return;
  }
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
  }
}
export function getMergeAdditions(localIds: string[], apiIds: string[]): string[] {
  return localIds.filter((id) => !apiIds.includes(id));
}
