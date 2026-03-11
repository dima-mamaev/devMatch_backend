"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { useMutation, useQuery, useSubscription } from "@apollo/client";
import {
  AI_MATCH_START_SESSION,
  AI_MATCH_SEND_MESSAGE,
  AI_MATCH_CANCEL,
  AI_MATCH_RATE_LIMIT_INFO,
  AI_MATCH_EVENTS,
} from "@/lib/graphql/operations";
import { useUser } from "./useUser";

// Event types from the backend
export type AIMatchEventType =
  | "CONNECTED"
  | "MESSAGE_QUEUED"
  | "MESSAGE_STARTED"
  | "THINKING"
  | "TOOL_CALL"
  | "TOOL_RESULT"
  | "MATCH_FOUND"
  | "COMPLETE"
  | "ERROR"
  | "CANCELLED"
  | "RATE_LIMITED";

export interface AIMatchDeveloper {
  id: string;
  firstName: string;
  lastName: string;
  jobTitle?: string;
  bio?: string;
  techStack: string[];
  seniorityLevel?: string;
  location?: string;
  availabilityStatus?: string;
  profilePhotoUrl?: string;
  experiences: Array<{
    companyName: string;
    position: string;
    yearsWorked: number;
  }>;
  projects: Array<{
    name: string;
    techStack: string[];
  }>;
}

export interface AIMatchEventData {
  message?: string;
  toolName?: string;
  resultSummary?: string;
  candidateCount?: number;
  match?: {
    developerId: string;
    matchScore: number;
    matchReason: string;
    developer?: AIMatchDeveloper;
  };
  summary?: string;
  totalMatches?: number;
  totalCandidates?: number;
  position?: number;
  errorMessage?: string;
  isOffTopic?: boolean;
}

export interface AIMatchEvent {
  type: AIMatchEventType;
  sessionId: string;
  messageId: string;
  timestamp: string;
  data?: AIMatchEventData;
}

export interface DeveloperMatch {
  developerId: string;
  firstName?: string;
  lastName?: string;
  jobTitle?: string;
  location?: string;
  techStack?: string[];
  seniorityLevel?: string;
  availabilityStatus?: string;
  score: number;
  reasoning: string;
  profilePhotoUrl?: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: Date;
  // For assistant messages
  matches?: DeveloperMatch[];
  isStreaming?: boolean;
  thinkingSteps?: string[];
  toolCalls?: Array<{
    name: string;
    status: "pending" | "running" | "completed";
    result?: string;
  }>;
  error?: string;
}

interface RateLimitInfo {
  remaining: number;
  limit: number;
  resetsAt: string;
}

// localStorage key for session persistence
const AI_MATCH_SESSION_KEY = "ai-match-session-id";

interface UseAIMatchReturn {
  // State
  sessionId: string | null;
  messages: ChatMessage[];
  isLoading: boolean;
  isProcessing: boolean;
  error: string | null;
  rateLimitInfo: RateLimitInfo | null;
  userType: string | null;

  // Actions
  startSession: () => Promise<void>;
  sendMessage: (prompt: string) => Promise<void>;
  cancelCurrent: () => Promise<void>;
  cancelAll: () => Promise<void>;
  clearMessages: (startFresh?: boolean) => void;
  clearError: () => void;
}

export function useAIMatch(): UseAIMatchReturn {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [userType, setUserType] = useState<string | null>(null);

  // Track auth state to detect login/logout
  const { user, isLoading: authLoading } = useUser();
  const prevUserIdRef = useRef<string | null | undefined>(undefined);

  // Track current message being processed
  const currentMessageIdRef = useRef<string | null>(null);

  // GraphQL mutations
  const [startSessionMutation] = useMutation(AI_MATCH_START_SESSION);
  const [sendMessageMutation] = useMutation(AI_MATCH_SEND_MESSAGE);
  const [cancelMutation] = useMutation(AI_MATCH_CANCEL);

  // Rate limit query
  const { data: rateLimitData, refetch: refetchRateLimit } = useQuery(
    AI_MATCH_RATE_LIMIT_INFO,
    {
      fetchPolicy: "network-only",
    }
  );

  // Subscription to AI Match events
  useSubscription(AI_MATCH_EVENTS, {
    variables: { sessionId: sessionId || "" },
    skip: !sessionId,
    onData: ({ data }) => {
      if (data.data?.aiMatchEvents) {
        handleEvent(data.data.aiMatchEvents as AIMatchEvent);
      }
    },
    onError: (err) => {
      console.error("[AIMatch] Subscription error:", err);
    },
  });

  // Handle incoming events
  const handleEvent = useCallback(
    (event: AIMatchEvent) => {
      console.log("[AIMatch] Event received:", event.type, event);
      const eventData = event.data || {};

      // Ignore events for cancelled messages (except CANCELLED itself)
      if (
        event.type !== "CONNECTED" &&
        event.type !== "MESSAGE_QUEUED" &&
        event.type !== "MESSAGE_STARTED" &&
        event.type !== "CANCELLED" &&
        currentMessageIdRef.current === null
      ) {
        console.log("[AIMatch] Ignoring event - message was cancelled");
        return;
      }

      switch (event.type) {
        case "CONNECTED":
          console.log("[AIMatch] Connected to session");
          break;

        case "MESSAGE_QUEUED":
          // Message was queued, nothing to show yet
          break;

        case "MESSAGE_STARTED":
          setIsProcessing(true);
          currentMessageIdRef.current = event.messageId;
          // Add a placeholder assistant message (deduplicate)
          setMessages((prev) => {
            // Check if message already exists
            if (prev.some((msg) => msg.id === event.messageId)) {
              return prev;
            }
            return [
              ...prev,
              {
                id: event.messageId,
                role: "assistant",
                content: "",
                timestamp: new Date(event.timestamp),
                isStreaming: true,
                thinkingSteps: [],
                toolCalls: [],
                matches: [],
              },
            ];
          });
          break;

        case "THINKING":
          // Add thinking step to current message
          setMessages((prev) =>
            prev.map((msg) => {
              if (msg.id === event.messageId) {
                const thought = eventData.message || "Thinking...";
                return {
                  ...msg,
                  thinkingSteps: [...(msg.thinkingSteps || []), thought],
                };
              }
              return msg;
            })
          );
          break;

        case "TOOL_CALL":
          // Add tool call to current message
          setMessages((prev) =>
            prev.map((msg) => {
              if (msg.id === event.messageId) {
                const toolName = eventData.toolName || "unknown";
                return {
                  ...msg,
                  toolCalls: [
                    ...(msg.toolCalls || []),
                    { name: toolName, status: "running" as const },
                  ],
                };
              }
              return msg;
            })
          );
          break;

        case "TOOL_RESULT":
          // Update tool call status
          setMessages((prev) =>
            prev.map((msg) => {
              if (msg.id === event.messageId) {
                const toolName = eventData.toolName;
                const toolCalls = msg.toolCalls?.map((tc) =>
                  tc.name === toolName
                    ? { ...tc, status: "completed" as const }
                    : tc
                );
                return { ...msg, toolCalls };
              }
              return msg;
            })
          );
          break;

        case "MATCH_FOUND":
          // Add developer match with full profile data
          setMessages((prev) =>
            prev.map((msg) => {
              if (msg.id === event.messageId && eventData.match) {
                const dev = eventData.match.developer;
                const match: DeveloperMatch = {
                  developerId: eventData.match.developerId,
                  score: eventData.match.matchScore,
                  reasoning: eventData.match.matchReason,
                  // Include enriched developer data if available
                  firstName: dev?.firstName,
                  lastName: dev?.lastName,
                  jobTitle: dev?.jobTitle,
                  location: dev?.location,
                  techStack: dev?.techStack,
                  seniorityLevel: dev?.seniorityLevel,
                  availabilityStatus: dev?.availabilityStatus,
                  profilePhotoUrl: dev?.profilePhotoUrl,
                };
                return {
                  ...msg,
                  matches: [...(msg.matches || []), match],
                };
              }
              return msg;
            })
          );
          break;

        case "COMPLETE":
          setIsProcessing(false);
          currentMessageIdRef.current = null;
          // Update message with final content
          setMessages((prev) =>
            prev.map((msg) => {
              if (msg.id === event.messageId) {
                const summary = eventData.summary || "";
                return {
                  ...msg,
                  content: summary,
                  isStreaming: false,
                };
              }
              return msg;
            })
          );
          // Refetch rate limit info
          refetchRateLimit();
          break;

        case "ERROR":
          setIsProcessing(false);
          currentMessageIdRef.current = null;
          // Update message with error
          setMessages((prev) =>
            prev.map((msg) => {
              if (msg.id === event.messageId) {
                return {
                  ...msg,
                  isStreaming: false,
                  error: eventData.errorMessage || "An error occurred",
                };
              }
              return msg;
            })
          );
          break;

        case "CANCELLED":
          setIsProcessing(false);
          currentMessageIdRef.current = null;
          // Mark message as cancelled
          setMessages((prev) =>
            prev.map((msg) => {
              if (msg.id === event.messageId) {
                return {
                  ...msg,
                  isStreaming: false,
                  content: msg.content || "Search cancelled.",
                };
              }
              return msg;
            })
          );
          break;

        case "RATE_LIMITED":
          setIsProcessing(false);
          setError("Rate limit exceeded. Please try again later.");
          break;
      }
    },
    [refetchRateLimit]
  );

  // Start session
  const startSession = useCallback(async () => {
    try {
      setIsLoading(true);
      setError(null);

      // Try to restore existing session from localStorage
      const storedSessionId = typeof window !== "undefined"
        ? localStorage.getItem(AI_MATCH_SESSION_KEY)
        : null;

      const { data } = await startSessionMutation({
        variables: {
          input: storedSessionId ? { sessionId: storedSessionId } : null,
        },
      });

      if (data?.aiMatchStartSession) {
        const newSessionId = data.aiMatchStartSession.sessionId;
        setSessionId(newSessionId);
        setUserType(data.aiMatchStartSession.userType);

        // Store sessionId in localStorage for persistence
        if (typeof window !== "undefined") {
          localStorage.setItem(AI_MATCH_SESSION_KEY, newSessionId);
        }

        // Load conversation history if available
        const history = data.aiMatchStartSession.conversationHistory || [];
        if (history.length > 0) {
          const restoredMessages: ChatMessage[] = history.map((msg: {
            id: string;
            role: string;
            content: string;
            timestamp: string;
            matches?: Array<{
              developerId: string;
              matchScore: number;
              matchReason: string;
              developer?: {
                id: string;
                firstName: string;
                lastName: string;
                jobTitle?: string;
                bio?: string;
                techStack: string[];
                seniorityLevel?: string;
                location?: string;
                availabilityStatus?: string;
                profilePhotoUrl?: string;
              };
            }>;
          }) => ({
            id: msg.id,
            role: msg.role as "user" | "assistant",
            content: msg.content,
            timestamp: new Date(msg.timestamp),
            matches: msg.matches?.map((m) => ({
              developerId: m.developerId,
              score: m.matchScore,
              reasoning: m.matchReason,
              // Include full developer data for consistent card rendering
              firstName: m.developer?.firstName,
              lastName: m.developer?.lastName,
              jobTitle: m.developer?.jobTitle,
              location: m.developer?.location,
              techStack: m.developer?.techStack,
              seniorityLevel: m.developer?.seniorityLevel,
              availabilityStatus: m.developer?.availabilityStatus,
              profilePhotoUrl: m.developer?.profilePhotoUrl,
            })),
          }));
          setMessages(restoredMessages);
        }

        // Refetch rate limit for fresh data
        refetchRateLimit();
      }
    } catch (err) {
      console.error("[AIMatch] Failed to start session:", err);
      setError("Failed to start session. Please try again.");
    } finally {
      setIsLoading(false);
    }
  }, [startSessionMutation, refetchRateLimit]);

  // Send message
  const sendMessage = useCallback(
    async (prompt: string) => {
      if (!sessionId || !prompt.trim()) return;

      // Add user message to chat optimistically
      const userMessageId = `user-${Date.now()}`;

      try {
        setError(null);

        setMessages((prev) => [
          ...prev,
          {
            id: userMessageId,
            role: "user",
            content: prompt.trim(),
            timestamp: new Date(),
          },
        ]);

        // Send to backend
        const { errors } = await sendMessageMutation({
          variables: {
            input: {
              sessionId,
              prompt: prompt.trim(),
            },
          },
        });

        // Handle GraphQL errors returned in result (Apollo doesn't throw by default)
        if (errors?.length) {
          throw errors[0];
        }
      } catch (err: unknown) {
        console.error("[AIMatch] Failed to send message:", err);

        // Remove the optimistically added user message
        setMessages((prev) => prev.filter((msg) => msg.id !== userMessageId));

        // Extract error message from GraphQL/Apollo error
        let errorMessage = "Failed to send message. Please try again.";
        let rawMessage = "";

        // Try to get the error message from various sources
        if (err instanceof Error) {
          rawMessage = err.message;
        }

        // Check for GraphQL errors (Apollo error structure)
        if (err && typeof err === "object") {
          const apolloErr = err as {
            graphQLErrors?: Array<{ message: string }>;
            message?: string;
          };

          if (apolloErr.graphQLErrors?.length) {
            rawMessage = apolloErr.graphQLErrors[0].message;
          } else if (apolloErr.message) {
            rawMessage = apolloErr.message;
          }
        }

        // Check if it's a rate limit error
        if (rawMessage.includes("Rate limit exceeded")) {
          const resetMatch = rawMessage.match(/Limit resets at ([^.]+)/);
          if (resetMatch) {
            const resetTime = new Date(resetMatch[1]);
            const formattedTime = resetTime.toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
            });
            errorMessage = `You've reached your daily search limit. Try again after ${formattedTime}.`;
          } else {
            errorMessage = "You've reached your daily search limit. Please try again tomorrow.";
          }
          // Refetch rate limit to update UI
          refetchRateLimit();
        } else if (rawMessage) {
          errorMessage = rawMessage;
        }

        setError(errorMessage);
      }
    },
    [sessionId, sendMessageMutation, refetchRateLimit]
  );

  // Cancel current run
  const cancelCurrent = useCallback(async () => {
    if (!sessionId) return;

    // Optimistically update UI immediately
    setIsProcessing(false);
    const messageId = currentMessageIdRef.current;
    if (messageId) {
      setMessages((prev) =>
        prev.map((msg) =>
          msg.id === messageId
            ? { ...msg, isStreaming: false, content: msg.content || "Search cancelled." }
            : msg
        )
      );
      currentMessageIdRef.current = null;
    }

    // Then notify backend
    try {
      await cancelMutation({
        variables: {
          input: {
            sessionId,
            target: "current",
          },
        },
      });
    } catch (err) {
      console.error("[AIMatch] Failed to cancel:", err);
    }
  }, [sessionId, cancelMutation]);

  // Cancel all
  const cancelAll = useCallback(async () => {
    if (!sessionId) return;

    try {
      await cancelMutation({
        variables: {
          input: {
            sessionId,
            target: "all",
          },
        },
      });
    } catch (err) {
      console.error("[AIMatch] Failed to cancel all:", err);
    }
  }, [sessionId, cancelMutation]);

  // Clear messages and optionally start a fresh session
  const clearMessages = useCallback((startFresh = false) => {
    setMessages([]);
    currentMessageIdRef.current = null;

    if (startFresh && typeof window !== "undefined") {
      localStorage.removeItem(AI_MATCH_SESSION_KEY);
      setSessionId(null);
    }
  }, []);

  // Detect auth state changes (login/logout) and reset session
  useEffect(() => {
    // Wait for auth to finish loading before tracking changes
    if (authLoading) return;

    const currentUserId = user?.id ?? null;

    // On first render after auth loads, just set the ref
    if (prevUserIdRef.current === undefined) {
      prevUserIdRef.current = currentUserId;
      return;
    }

    // If user ID changed (login or logout), reset session
    if (prevUserIdRef.current !== currentUserId) {
      prevUserIdRef.current = currentUserId;

      // Clear local state
      setMessages([]);
      setSessionId(null);
      currentMessageIdRef.current = null;

      // Clear localStorage - backend will provide the right session
      if (typeof window !== "undefined") {
        localStorage.removeItem(AI_MATCH_SESSION_KEY);
      }

      // Refetch rate limit for new user context
      refetchRateLimit();
    }
  }, [authLoading, user?.id, refetchRateLimit]);

  // Auto-start session on mount (wait for auth to load)
  useEffect(() => {
    if (authLoading) return;
    if (!sessionId) {
      startSession();
    }
  }, [sessionId, startSession, authLoading]);

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  return {
    sessionId,
    messages,
    isLoading: isLoading || authLoading,
    isProcessing,
    error,
    rateLimitInfo: rateLimitData?.aiMatchRateLimitInfo || null,
    userType,
    startSession,
    sendMessage,
    cancelCurrent,
    cancelAll,
    clearMessages,
    clearError,
  };
}
