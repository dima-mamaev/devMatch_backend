"use client";

import { useAuth0 } from "@auth0/auth0-react";
import { useGetMeQuery, Developer, Recruiter, User } from "@/lib/graphql/generated";

/**
 * Single source of truth for user authentication state.
 * Combines Auth0 authentication with API user data.
 */
export function useUser() {
  const {
    isAuthenticated: auth0Authenticated,
    isLoading: auth0Loading,
    user: auth0User,
  } = useAuth0();

  const { data, loading: apiLoading } = useGetMeQuery({
    skip: !auth0Authenticated,
    fetchPolicy: "cache-first",
  });

  const isLoading = auth0Loading || (auth0Authenticated && apiLoading);
  const user = data?.user?.getMe ?? null;
  const profile = user?.profile ?? null;

  return {
    isLoading,
    isGuest: !isLoading && !auth0Authenticated,
    isAuthenticated: !isLoading && !!user,
    isEmailVerified: auth0User?.email_verified ?? false,
    user,
    profile,
    isDeveloper: user?.role === "Developer",
    isRecruiter: user?.role === "Recruiter",
  };
}
export function useIsGuest(): boolean {
  const { isGuest } = useUser();
  return isGuest;
}
export function useIsAuthenticated(): boolean {
  const { isAuthenticated } = useUser();
  return isAuthenticated;
}
export function useDeveloperProfile(): Developer | null {
  const { isAuthenticated, isDeveloper, profile } = useUser();
  if (isAuthenticated && isDeveloper && profile) {
    return profile as Developer;
  }
  return null;
}
export function useRecruiterProfile(): Recruiter | null {
  const { isAuthenticated, isRecruiter, profile } = useUser();
  if (isAuthenticated && isRecruiter && profile) {
    return profile as Recruiter;
  }
  return null;
}
export function useCurrentUser(): User | null {
  const { user } = useUser();
  return user as any;
}
export type UserState = ReturnType<typeof useUser>;
