import { useCallback, useState, useEffect, useRef } from "react";
import { useUser } from "./useUser";
import {
  useGetMyShortlistQuery,
  useGetMyShortlistCountQuery,
  useIsInMyShortlistQuery,
  useAddToShortlistMutation,
  useRemoveFromShortlistMutation,
  useClearMyShortlistMutation,
} from "@/lib/graphql/generated";
import {
  getLocalShortlist,
  addToLocalShortlist,
  removeFromLocalShortlist,
  isInLocalShortlist,
  clearLocalShortlist,
} from "@/lib/utils/localShortlist";

export function useShortlist() {
  const { isGuest, isLoading: userLoading } = useUser();

  const [localShortlistIds, setLocalShortlistIds] = useState<string[]>([]);

  const isLocalMode = isGuest;

  useEffect(() => {
    if (isLocalMode) {
      setLocalShortlistIds(getLocalShortlist());
    }
  }, [isLocalMode]);

  const {
    data: shortlistData,
    loading: shortlistLoading,
    refetch: refetchShortlist,
  } = useGetMyShortlistQuery({
    fetchPolicy: "cache-and-network",
    skip: isLocalMode || userLoading,
  });

  const {
    data: countData,
    refetch: refetchCount,
  } = useGetMyShortlistCountQuery({
    fetchPolicy: "cache-and-network",
    skip: isLocalMode || userLoading,
  });

  const [addToShortlistMutation, { loading: addingToShortlist }] =
    useAddToShortlistMutation();

  const [removeFromShortlistMutation, { loading: removingFromShortlist }] =
    useRemoveFromShortlistMutation();

  const [clearShortlistMutation, { loading: clearingShortlist }] =
    useClearMyShortlistMutation();

  const refetchShortlistRef = useRef(refetchShortlist);
  refetchShortlistRef.current = refetchShortlist;
  const refetchCountRef = useRef(refetchCount);
  refetchCountRef.current = refetchCount;
  const addToShortlistMutationRef = useRef(addToShortlistMutation);
  addToShortlistMutationRef.current = addToShortlistMutation;
  const removeFromShortlistMutationRef = useRef(removeFromShortlistMutation);
  removeFromShortlistMutationRef.current = removeFromShortlistMutation;
  const clearShortlistMutationRef = useRef(clearShortlistMutation);
  clearShortlistMutationRef.current = clearShortlistMutation;

  const apiShortlist = shortlistData?.getMyShortlist ?? [];
  const apiShortlistCount = countData?.getMyShortlistCount ?? 0;

  const shortlistCount = isLocalMode ? localShortlistIds.length : apiShortlistCount;

  const isInShortlist = useCallback(
    (developerId: string) => {
      if (isLocalMode) {
        return localShortlistIds.includes(developerId);
      }
      return apiShortlist.some((entry) => entry.developer.id === developerId);
    },
    [isLocalMode, localShortlistIds, apiShortlist]
  );

  const addToShortlist = useCallback(
    async (developerId: string) => {
      if (isLocalMode) {
        const success = addToLocalShortlist(developerId);
        if (success) {
          setLocalShortlistIds(getLocalShortlist());
        }
        return success;
      }

      try {
        await addToShortlistMutationRef.current({
          variables: { developerId },
        });
        refetchShortlistRef.current();
        refetchCountRef.current();
        return true;
      } catch (error) {
        console.error("Failed to add to shortlist:", error);
        return false;
      }
    },
    [isLocalMode]
  );

  const removeFromShortlist = useCallback(
    async (developerId: string) => {
      if (isLocalMode) {
        removeFromLocalShortlist(developerId);
        setLocalShortlistIds(getLocalShortlist());
        return true;
      }

      try {
        await removeFromShortlistMutationRef.current({
          variables: { developerId },
        });
        refetchShortlistRef.current();
        refetchCountRef.current();
        return true;
      } catch (error) {
        console.error("Failed to remove from shortlist:", error);
        return false;
      }
    },
    [isLocalMode]
  );

  const toggleShortlist = useCallback(
    async (developerId: string) => {
      if (isInShortlist(developerId)) {
        return removeFromShortlist(developerId);
      } else {
        return addToShortlist(developerId);
      }
    },
    [isInShortlist, addToShortlist, removeFromShortlist]
  );

  const clearShortlistAction = useCallback(async () => {
    if (isLocalMode) {
      clearLocalShortlist();
      setLocalShortlistIds([]);
      return true;
    }

    try {
      await clearShortlistMutationRef.current();
      refetchShortlistRef.current();
      refetchCountRef.current();
      return true;
    } catch (error) {
      console.error("Failed to clear shortlist:", error);
      return false;
    }
  }, [isLocalMode]);

  const shortlistIds = isLocalMode
    ? localShortlistIds
    : apiShortlist.map((entry) => entry.developer.id);

  return {
    shortlistIds,
    shortlistCount,
    shortlistLoading: isLocalMode ? false : (shortlistLoading || userLoading),
    isInShortlist,
    addToShortlist,
    removeFromShortlist,
    toggleShortlist,
    clearShortlist: clearShortlistAction,
    isLoading: addingToShortlist || removingFromShortlist || clearingShortlist,
    isLocalMode,
  };
}

export function useIsInShortlist(developerId: string) {
  const { isGuest, isLoading: userLoading } = useUser();
  const isLocalMode = isGuest;

  const [localIsIn, setLocalIsIn] = useState(false);

  useEffect(() => {
    if (isLocalMode) {
      setLocalIsIn(isInLocalShortlist(developerId));
    }
  }, [isLocalMode, developerId]);

  const { data, loading, refetch } = useIsInMyShortlistQuery({
    variables: { developerId },
    skip: !developerId || isLocalMode || userLoading,
    fetchPolicy: "cache-and-network",
  });

  const refetchRef = useRef(refetch);
  refetchRef.current = refetch;

  const refetchAll = useCallback(() => {
    if (isLocalMode) {
      setLocalIsIn(isInLocalShortlist(developerId));
    } else {
      refetchRef.current();
    }
  }, [isLocalMode, developerId]);

  return {
    isInShortlist: isLocalMode ? localIsIn : (data?.isInMyShortlist ?? false),
    loading: isLocalMode ? false : loading,
    refetch: refetchAll,
  };
}
