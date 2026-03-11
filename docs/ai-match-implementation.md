# AI Match Feature Implementation Guide

## Overview

The AI Match feature allows recruiters to find matching developers using natural language prompts. An **OpenAI Agent** (using the Assistants API) analyzes the prompt, calls database tools to search developers, and returns ranked matches with explanations.

---

## Architecture

### Microservices Overview

The AI Match feature uses a **microservices architecture** with three services:

| Service | Responsibility | Port | Communication |
|---------|----------------|------|---------------|
| **Main API** | GraphQL gateway, auth, rate limiting, WebSocket | 4000 | GraphQL + WebSocket |
| **AI Agent Service** | OpenAI interactions, tool execution | 4001 | HTTP REST |
| **Cron Service** | Scheduled cleanup, maintenance | 4003 | Internal only |

### High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                              Frontend (Next.js)                                     │
└───────────────────────────────────┬─────────────────────────┬───────────────────────┘
                                    │ GraphQL                 │ WebSocket
                                    ▼                         ▼
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                              MAIN API SERVICE (Port 4000)                           │
│                                                                                     │
│   • GraphQL resolvers     • Session management      • Rate limiting                 │
│   • Authentication        • WebSocket subscriptions • Message queue                 │
└───────────────────────────────────┬─────────────────────────────────────────────────┘
                                    │
                                    │ HTTP POST /api/match (simple REST)
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                          AI AGENT SERVICE (Port 4001)                               │
│                                                                                     │
│   • OpenAI Assistants API       • Tool handlers (search developers)                 │
│   • Thread management           • Publishes events to Redis                         │
└───────────────────────────────────┬─────────────────────────────────────────────────┘
                                    │
            ┌───────────────────────┼───────────────────────┐
            ▼                       ▼                       ▼
      ┌──────────┐           ┌───────────┐           ┌────────────┐
      │  OpenAI  │           │   Redis   │           │ PostgreSQL │
      │   API    │           │  Pub/Sub  │           │ Developers │
      └──────────┘           └───────────┘           └────────────┘
                                    ▲
                                    │
┌───────────────────────────────────┴─────────────────────────────────────────────────┐
│                          CRON SERVICE (Port 4003)                                   │
│                                                                                     │
│   • Thread cleanup (daily)      • Session expiry (hourly)                           │
│   • No inbound traffic          • Runs independently                                │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

### Service Communication (Simplified)

```
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                        Communication Patterns (HTTP-based)                          │
├─────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                     │
│   Frontend ◄────WebSocket────► Main API                                            │
│                                    │                                                │
│                                    │ HTTP POST /api/match                           │
│                                    │ (returns immediately, streams via Redis)       │
│                                    ▼                                                │
│                              AI Agent Service                                       │
│                                    │                                                │
│                                    │ Redis PUBLISH (events)                         │
│                                    ▼                                                │
│   Main API ◄────SUBSCRIBE────► Redis Pub/Sub ────► Frontend (via WebSocket)        │
│                                                                                     │
│   Cron Service ────────────► Redis + PostgreSQL + OpenAI (direct)                  │
│                                                                                     │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

**Why HTTP instead of gRPC?**
- Simpler debugging (curl, Postman)
- No proto files needed
- Events stream via Redis anyway
- Less tooling/setup

## Communication Flow

```
1. User sends message
         │
         ▼
2. Frontend subscribes to session channel
         │
         ▼
3. Backend queues message (if one is processing)
         │
         ▼
4. Backend streams OpenAI events → Frontend
         │
         ├──► THINKING: "Analyzing your request..."
         ├──► TOOL_CALL: "Searching for React developers..."
         ├──► TOOL_RESULT: "Found 25 candidates"
         ├──► MATCH_FOUND: { developer, score, reason }
         ├──► MATCH_FOUND: { developer, score, reason }
         └──► COMPLETE: { summary, totalCandidates }

5. Next queued message (if any) starts automatically
```

## Why OpenAI Agent?

Using the Assistants API instead of simple chat completions provides:

1. **Function Calling** - Agent can call database tools to search/filter developers
2. **Multi-step Reasoning** - Agent iteratively refines searches based on results
3. **Persistent Threads** - Conversation context maintained for follow-up queries
4. **Built-in Tool Execution Loop** - OpenAI handles the tool call → response cycle

---

## Access Control & Rate Limiting

### User Access Levels

| User Type | Access | Rate Limit | Features |
|-----------|--------|------------|----------|
| **Guest** | Yes | 3 searches/day | Basic matching, limited results (5 max) |
| **Authenticated User** | Yes | 20 searches/day | Full matching, all results, conversation threads |
| **Recruiter (Paid)** | Yes | Unlimited | All features + saved searches, export |

### Guest Limitations
- Maximum 3 AI match searches per day (tracked by IP + fingerprint)
- Results limited to top 5 matches
- No conversation continuity (no threadId)
- Prompt to sign up after each search
- Cannot add to shortlist (must sign in)

### Authenticated User Limits
- 20 AI match searches per day (resets at midnight UTC)
- Full results (up to 10 matches)
- Conversation continuity supported
- Can save to shortlist
- Usage tracked per user ID

### Rate Limit Implementation

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   Request       │────▶│   Rate Limiter  │────▶│   AI Agent      │
│   (user/guest)  │     │   (Redis)       │     │                 │
└─────────────────┘     └─────────────────┘     └─────────────────┘
                               │
                        Check limit by:
                        - userId (if authenticated)
                        - IP + fingerprint (if guest)
```

---

## Prompt Validation & Guardrails

### Scope Restriction

The AI agent is **strictly scoped** to developer search queries. Off-topic prompts should receive a polite redirect response.

### Valid Prompts (Developer Search)
- "Senior React developer with AWS experience"
- "Find me a mobile developer who knows Flutter"
- "Backend engineers available for contract work"
- "Developers in San Francisco with Python skills"

### Invalid Prompts (Off-Topic)
- "What's the weather today?"
- "Write me a poem"
- "How do I cook pasta?"
- "Tell me a joke"

### Response for Off-Topic Prompts

```json
{
  "matches": [],
  "searchSummary": "I'm designed specifically to help you find developers. Please describe the type of developer you're looking for - including skills, experience level, or technologies.",
  "totalCandidates": 0,
  "isOffTopic": true
}
```

### Implementation in Assistant Instructions

The agent instructions include guardrails to:
1. Detect off-topic prompts before calling any tools
2. Return a helpful redirect message
3. Not waste API calls on irrelevant queries

---

## Real-time Streaming & Message Queue

### Message Queue System

When a user sends messages while one is processing, they are queued and processed sequentially in the same conversation thread.

```
┌─────────────────────────────────────────────────────────────┐
│  Session: user_123                                          │
│                                                             │
│  Thread: thread_abc                                         │
│                                                             │
│  Queue:                                                     │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ [Processing] "Find React developers"                 │   │
│  │ [Queued #1]  "Make sure they know TypeScript"       │   │
│  │ [Queued #2]  "Remote only please"                   │   │
│  └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

### Event Types

```typescript
enum AIMatchEventType {
  // Connection events
  CONNECTED = 'CONNECTED',           // Subscription established
  DISCONNECTED = 'DISCONNECTED',     // Subscription ended

  // Queue events
  MESSAGE_QUEUED = 'MESSAGE_QUEUED', // Message added to queue
  MESSAGE_STARTED = 'MESSAGE_STARTED', // Processing started

  // Progress events
  THINKING = 'THINKING',             // Agent analyzing request
  TOOL_CALL = 'TOOL_CALL',           // Agent calling a tool
  TOOL_RESULT = 'TOOL_RESULT',       // Tool returned results
  MATCH_FOUND = 'MATCH_FOUND',       // Individual match scored

  // Completion events
  COMPLETE = 'COMPLETE',             // Search finished
  ERROR = 'ERROR',                   // Something went wrong

  // Control events
  CANCELLED = 'CANCELLED',           // User cancelled
  RATE_LIMITED = 'RATE_LIMITED',     // Hit rate limit
}

interface AIMatchEvent {
  type: AIMatchEventType;
  sessionId: string;
  messageId: string;
  timestamp: string;
  data?: {
    // For THINKING
    message?: string;

    // For TOOL_CALL
    toolName?: string;
    toolArgs?: Record<string, any>;

    // For TOOL_RESULT
    resultSummary?: string;
    candidateCount?: number;

    // For MATCH_FOUND
    match?: {
      developer: Developer;
      matchScore: number;
      matchReason: string;
    };

    // For COMPLETE
    summary?: string;
    totalMatches?: number;
    totalCandidates?: number;

    // For MESSAGE_QUEUED
    position?: number;

    // For ERROR
    errorMessage?: string;
    errorCode?: string;
  };
}
```

### Session State (Redis)

```typescript
interface SessionState {
  sessionId: string;
  userId: string | null;        // null for guests
  threadId: string | null;      // OpenAI thread ID
  messageQueue: QueuedMessage[];
  createdAt: string;
  lastActivityAt: string;
}

// Note: currentRunId is stored separately in Redis by AI Agent service
// at key: ai-match:run:${sessionId}

interface QueuedMessage {
  messageId: string;
  prompt: string;
  status: 'queued' | 'processing' | 'completed' | 'failed' | 'cancelled';
  queuedAt: string;
  startedAt?: string;
  completedAt?: string;
}

// Redis keys
// ai-match:session:{sessionId} → SessionState
// ai-match:session:{sessionId}:queue → List of QueuedMessage
// ai-match:ratelimit:{userType}:{identifier} → count
```

### Cancellation Behavior

User can cancel:
- **Current processing message** → Stops OpenAI run, moves to next in queue
- **Queued message** → Removes from queue
- **Entire session** → Cancels all, clears queue

```typescript
// Cancel options
interface CancelRequest {
  sessionId: string;
  target: 'current' | 'queued' | 'all';
  messageId?: string; // Required for 'queued'
}
```

---

## API Changes

### 1. New GraphQL Types

**File:** `api/apps/api/src/ai-match/models/ai-match.model.ts`

```typescript
import { Field, ObjectType, Float, Int } from "@nestjs/graphql";
import { Developer } from "../../developer/developer.entity";

@ObjectType()
export class AIMatchResult {
  @Field(() => Developer)
  developer: Developer;

  @Field(() => Float)
  matchScore: number; // 0-100

  @Field(() => String)
  matchReason: string; // AI-generated explanation
}

@ObjectType()
export class AIMatchResponse {
  @Field(() => [AIMatchResult])
  matches: AIMatchResult[];

  @Field(() => String)
  searchSummary: string; // AI summary of search criteria

  @Field(() => Int)
  totalCandidates: number;

  @Field(() => String, { nullable: true })
  threadId?: string; // OpenAI thread ID for conversation continuity

  @Field(() => Boolean, { defaultValue: false })
  isOffTopic: boolean; // True if prompt was not related to developer search
}

@ObjectType()
export class AIMatchRateLimitInfo {
  @Field(() => Int)
  remaining: number; // Searches remaining today

  @Field(() => Int)
  limit: number; // Total daily limit

  @Field(() => String)
  resetsAt: string; // ISO timestamp when limit resets
}

@ObjectType()
export class AIMatchSession {
  @Field(() => String)
  sessionId: string;

  @Field(() => String)
  userType: string; // 'guest' | 'authenticated' | 'recruiter'

  @Field(() => Int)
  maxResults: number;
}

@ObjectType()
export class QueuedMessageInfo {
  @Field(() => String)
  messageId: string;

  @Field(() => String)
  prompt: string;

  @Field(() => String)
  status: string; // 'queued' | 'processing' | 'completed' | 'failed' | 'cancelled'

  @Field(() => String)
  queuedAt: string;
}

@ObjectType()
export class AIMatchQueueStatus {
  @Field(() => QueuedMessageInfo, { nullable: true })
  processing?: QueuedMessageInfo;

  @Field(() => [QueuedMessageInfo])
  queued: QueuedMessageInfo[];
}

// Event type for subscriptions
@ObjectType()
export class AIMatchEventData {
  @Field(() => String, { nullable: true })
  message?: string;

  @Field(() => String, { nullable: true })
  toolName?: string;

  @Field(() => String, { nullable: true })
  resultSummary?: string;

  @Field(() => Int, { nullable: true })
  candidateCount?: number;

  @Field(() => AIMatchResult, { nullable: true })
  match?: AIMatchResult;

  @Field(() => String, { nullable: true })
  summary?: string;

  @Field(() => Int, { nullable: true })
  totalMatches?: number;

  @Field(() => Int, { nullable: true })
  totalCandidates?: number;

  @Field(() => Int, { nullable: true })
  position?: number;

  @Field(() => String, { nullable: true })
  errorMessage?: string;

  @Field(() => Boolean, { nullable: true })
  isOffTopic?: boolean;
}

@ObjectType()
export class AIMatchEvent {
  @Field(() => String)
  type: string; // AIMatchEventType

  @Field(() => String)
  sessionId: string;

  @Field(() => String)
  messageId: string;

  @Field(() => String)
  timestamp: string;

  @Field(() => AIMatchEventData, { nullable: true })
  data?: AIMatchEventData;
}
```

### 2. New Input Types

**File:** `api/apps/api/src/ai-match/inputs/ai-match.input.ts`

```typescript
import { Field, InputType, Int } from "@nestjs/graphql";
import { IsNotEmpty, IsString, Max, Min, IsOptional } from "class-validator";

@InputType()
export class AIMatchSendInput {
  @Field()
  @IsNotEmpty()
  @IsString()
  sessionId: string; // Session ID from aiMatchStartSession

  @Field()
  @IsNotEmpty()
  @IsString()
  prompt: string; // Natural language search query

  @Field(() => [String], { nullable: true })
  @IsOptional()
  excludeDeveloperIds?: string[]; // Exclude already reviewed developers
}

@InputType()
export class AIMatchCancelInput {
  @Field()
  @IsNotEmpty()
  @IsString()
  sessionId: string;

  @Field()
  @IsNotEmpty()
  @IsString()
  target: string; // 'current' | 'queued' | 'all'

  @Field(() => String, { nullable: true })
  @IsOptional()
  messageId?: string; // Required when target is 'queued'
}
```

### 3. Microservices Project Structure

```
api/
├── apps/
│   ├── api/                          # MAIN API SERVICE (existing, extended)
│   │   ├── src/
│   │   │   ├── ai-match/
│   │   │   │   ├── ai-match.module.ts
│   │   │   │   ├── ai-match.resolver.ts      # GraphQL resolvers
│   │   │   │   ├── ai-match.service.ts       # Orchestrates via HTTP
│   │   │   │   ├── http/
│   │   │   │   │   └── ai-agent.client.ts    # HTTP client for AI Agent
│   │   │   │   ├── streaming/
│   │   │   │   │   └── pubsub.service.ts     # Redis subscriber for events
│   │   │   │   ├── session/
│   │   │   │   │   ├── session.service.ts
│   │   │   │   │   └── session.types.ts
│   │   │   │   ├── queue/
│   │   │   │   │   ├── message-queue.service.ts
│   │   │   │   │   └── queue.types.ts
│   │   │   │   ├── rate-limit/
│   │   │   │   │   ├── rate-limit.service.ts
│   │   │   │   │   └── rate-limit.types.ts
│   │   │   │   ├── inputs/
│   │   │   │   │   └── ai-match.input.ts
│   │   │   │   └── models/
│   │   │   │       └── ai-match.model.ts
│   │   │   └── ...
│   │   ├── main.ts
│   │   └── Dockerfile
│   │
│   ├── ai-agent/                     # AI AGENT SERVICE (new microservice)
│   │   ├── src/
│   │   │   ├── ai-agent.module.ts
│   │   │   ├── ai-agent.controller.ts        # HTTP REST handlers
│   │   │   ├── openai/
│   │   │   │   ├── openai-agent.service.ts   # OpenAI Assistants API
│   │   │   │   ├── assistant-config.ts
│   │   │   │   └── tools/
│   │   │   │       ├── tool-definitions.ts
│   │   │   │       └── tool-handlers.ts
│   │   │   └── events/
│   │   │       └── event-publisher.service.ts # Publishes to Redis
│   │   ├── main.ts
│   │   └── Dockerfile
│   │
│   └── cron/                         # CRON SERVICE (new microservice)
│       ├── src/
│       │   ├── cron.module.ts
│       │   ├── jobs/
│       │   │   ├── thread-cleanup.job.ts     # Daily: cleanup OpenAI threads
│       │   │   ├── session-expiry.job.ts     # Hourly: expire stale sessions
│       │   │   ├── usage-stats.job.ts        # Daily: aggregate analytics
│       │   │   └── health-check.job.ts       # Every 5min: check services
│       │   └── services/
│       │       ├── openai-cleanup.service.ts
│       │       └── redis-cleanup.service.ts
│       ├── main.ts
│       └── Dockerfile
│
├── libs/
│   └── shared/                       # SHARED LIBRARY (used by all services)
│       ├── src/
│       │   ├── types/
│       │   │   ├── session.types.ts
│       │   │   ├── event.types.ts
│       │   │   ├── queue.types.ts
│       │   │   └── developer.types.ts
│       │   ├── constants/
│       │   │   └── redis-keys.ts
│       │   └── index.ts
│       └── tsconfig.lib.json
│
├── docker-compose.yml
├── docker-compose.prod.yml
└── nest-cli.json                     # NestJS monorepo configuration
```

### 4. HTTP API Endpoints (AI Agent Service)

The AI Agent Service exposes simple REST endpoints. Events are streamed via Redis Pub/Sub, not HTTP streaming.

**Endpoints:**

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/match` | Start a matching request |
| `POST` | `/api/cancel` | Cancel an in-progress run |
| `GET` | `/health` | Health check |

**Request/Response Types:**

```typescript
// POST /api/match
interface MatchingRequest {
  sessionId: string;
  messageId: string;
  prompt: string;
  threadId?: string;      // For conversation continuity
  excludeIds?: string[];  // Developer IDs to exclude
  maxResults?: number;    // Limit based on user type
}

interface MatchingResponse {
  success: boolean;
  threadId: string;       // OpenAI thread ID for continuity
  message: string;
}

// POST /api/cancel
interface CancelRequest {
  sessionId: string;
  threadId: string;
  runId: string;
}

interface CancelResponse {
  success: boolean;
  message: string;
}

// GET /health
interface HealthResponse {
  healthy: boolean;
  openaiStatus: string;
  redisStatus: string;
  postgresStatus: string;
}
```

**Note:** The actual match results are streamed via Redis Pub/Sub events (THINKING, TOOL_CALL, MATCH_FOUND, COMPLETE, etc.), not returned in the HTTP response.

### 5. NestJS Monorepo Configuration

**File:** `api/nest-cli.json`

```json
{
  "collection": "@nestjs/schematics",
  "sourceRoot": "apps/api/src",
  "monorepo": true,
  "root": "apps/api",
  "compilerOptions": {
    "webpack": true,
    "tsConfigPath": "apps/api/tsconfig.app.json"
  },
  "projects": {
    "api": {
      "type": "application",
      "root": "apps/api",
      "entryFile": "main",
      "sourceRoot": "apps/api/src",
      "compilerOptions": {
        "tsConfigPath": "apps/api/tsconfig.app.json"
      }
    },
    "ai-agent": {
      "type": "application",
      "root": "apps/ai-agent",
      "entryFile": "main",
      "sourceRoot": "apps/ai-agent/src",
      "compilerOptions": {
        "tsConfigPath": "apps/ai-agent/tsconfig.app.json"
      }
    },
    "cron": {
      "type": "application",
      "root": "apps/cron",
      "entryFile": "main",
      "sourceRoot": "apps/cron/src",
      "compilerOptions": {
        "tsConfigPath": "apps/cron/tsconfig.app.json"
      }
    },
    "shared": {
      "type": "library",
      "root": "libs/shared",
      "entryFile": "index",
      "sourceRoot": "libs/shared/src",
      "compilerOptions": {
        "tsConfigPath": "libs/shared/tsconfig.lib.json"
      }
    }
  }
}
```

### 6. HTTP Client (Main API)

**File:** `api/apps/api/src/ai-match/http/ai-agent.client.ts`

```typescript
import { Injectable, Logger } from "@nestjs/common";
import { HttpService } from "@nestjs/axios";
import { ConfigService } from "@nestjs/config";
import { firstValueFrom } from "rxjs";

interface MatchingRequest {
  sessionId: string;
  messageId: string;
  prompt: string;
  threadId?: string;
  excludeIds?: string[];
  maxResults?: number;
}

interface MatchingResponse {
  success: boolean;
  threadId: string;
  message: string;
}

interface CancelRequest {
  sessionId: string;
  threadId: string;
  runId: string;
}

interface CancelResponse {
  success: boolean;
  message: string;
}

interface HealthResponse {
  healthy: boolean;
  openaiStatus: string;
  redisStatus: string;
  postgresStatus: string;
}

@Injectable()
export class AIAgentClient {
  private readonly logger = new Logger(AIAgentClient.name);
  private readonly baseUrl: string;

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService
  ) {
    this.baseUrl = this.configService.get<string>("AI_AGENT_URL", "http://localhost:4001");
  }

  async runMatchingAgent(request: MatchingRequest): Promise<MatchingResponse> {
    try {
      const response = await firstValueFrom(
        this.httpService.post<MatchingResponse>(`${this.baseUrl}/api/match`, request)
      );
      return response.data;
    } catch (error) {
      this.logger.error(`Failed to call AI Agent: ${error.message}`);
      throw error;
    }
  }

  async cancelRun(request: CancelRequest): Promise<CancelResponse> {
    try {
      const response = await firstValueFrom(
        this.httpService.post<CancelResponse>(`${this.baseUrl}/api/cancel`, request)
      );
      return response.data;
    } catch (error) {
      this.logger.error(`Failed to cancel run: ${error.message}`);
      throw error;
    }
  }

  async healthCheck(): Promise<HealthResponse> {
    try {
      const response = await firstValueFrom(
        this.httpService.get<HealthResponse>(`${this.baseUrl}/health`)
      );
      return response.data;
    } catch (error) {
      this.logger.error(`Health check failed: ${error.message}`);
      throw error;
    }
  }
}
```

### 7. AI Agent Service - Main Entry

**File:** `api/apps/ai-agent/src/main.ts`

```typescript
import { NestFactory } from "@nestjs/core";
import { AIAgentModule } from "./ai-agent.module";

async function bootstrap() {
  const app = await NestFactory.create(AIAgentModule);

  const port = process.env.AI_AGENT_PORT || 4001;
  await app.listen(port);

  console.log(`AI Agent Service is running on port ${port}`);
}

bootstrap();
```

**File:** `api/apps/ai-agent/src/ai-agent.module.ts`

```typescript
import { Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { TypeOrmModule } from "@nestjs/typeorm";
import { AIAgentController } from "./ai-agent.controller";
import { OpenAIAgentService } from "./openai/openai-agent.service";
import { ToolHandlers } from "./openai/tools/tool-handlers";
import { EventPublisherService } from "./events/event-publisher.service";
import { Developer } from "@app/shared/entities/developer.entity";

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => ({
        type: "postgres",
        url: configService.get("DATABASE_URL"),
        entities: [Developer],
        synchronize: false,
      }),
      inject: [ConfigService],
    }),
    TypeOrmModule.forFeature([Developer]),
  ],
  controllers: [AIAgentController],
  providers: [OpenAIAgentService, ToolHandlers, EventPublisherService],
})
export class AIAgentModule {}
```

**File:** `api/apps/ai-agent/src/ai-agent.controller.ts`

```typescript
import { Controller, Post, Get, Body, Logger } from "@nestjs/common";
import { OpenAIAgentService } from "./openai/openai-agent.service";
import { EventPublisherService } from "./events/event-publisher.service";

interface MatchingRequest {
  sessionId: string;
  messageId: string;
  prompt: string;
  threadId?: string;
  excludeIds?: string[];
  maxResults?: number;
}

interface CancelRequest {
  sessionId: string;
  threadId: string;
  runId: string;
}

@Controller()
export class AIAgentController {
  private readonly logger = new Logger(AIAgentController.name);

  constructor(
    private readonly openaiService: OpenAIAgentService,
    private readonly eventPublisher: EventPublisherService
  ) {}

  @Post("api/match")
  async runMatchingAgent(@Body() request: MatchingRequest) {
    this.logger.log(`Starting match for session: ${request.sessionId}`);

    // Get or create thread synchronously so we can return threadId
    const threadId = await this.openaiService.getOrCreateThread(request.threadId);

    // Fire and forget - process async, events published via Redis
    // Don't await - return immediately to caller
    this.openaiService
      .runMatchingAgentStreaming(
        request.sessionId,
        request.messageId,
        request.prompt,
        threadId,
        request.excludeIds,
        request.maxResults
      )
      .catch((error) => {
        this.logger.error(`Match processing failed: ${error.message}`);
        // Publish error event so frontend knows
        this.eventPublisher.publishError(
          request.sessionId,
          request.messageId,
          error.message
        );
      });

    return {
      success: true,
      threadId,
      message: "Processing started",
    };
  }

  @Post("api/cancel")
  async cancelRun(@Body() request: CancelRequest) {
    const success = await this.openaiService.cancelRun(request.threadId, request.runId);
    return {
      success,
      message: success ? "Run cancelled" : "Failed to cancel",
    };
  }

  @Get("health")
  async healthCheck() {
    return this.openaiService.healthCheck();
  }
}
```

### 8. Cron Service Implementation

**File:** `api/apps/cron/src/main.ts`

```typescript
import { NestFactory } from "@nestjs/core";
import { CronModule } from "./cron.module";

async function bootstrap() {
  const app = await NestFactory.create(CronModule);

  // Cron service doesn't need to listen on a port
  // but we start it to initialize the scheduler
  await app.init();

  console.log("⏰ Cron Service is running");
}

bootstrap();
```

**File:** `api/apps/cron/src/cron.module.ts`

```typescript
import { Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { ScheduleModule } from "@nestjs/schedule";
import { TypeOrmModule } from "@nestjs/typeorm";
import { ThreadCleanupJob } from "./jobs/thread-cleanup.job";
import { SessionExpiryJob } from "./jobs/session-expiry.job";
import { UsageStatsJob } from "./jobs/usage-stats.job";
import { HealthCheckJob } from "./jobs/health-check.job";
import { OpenAICleanupService } from "./services/openai-cleanup.service";
import { RedisCleanupService } from "./services/redis-cleanup.service";

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => ({
        type: "postgres",
        url: configService.get("DATABASE_URL"),
        synchronize: false,
      }),
      inject: [ConfigService],
    }),
  ],
  providers: [
    // Jobs
    ThreadCleanupJob,
    SessionExpiryJob,
    UsageStatsJob,
    HealthCheckJob,
    // Services
    OpenAICleanupService,
    RedisCleanupService,
  ],
})
export class CronModule {}
```

**File:** `api/apps/cron/src/jobs/thread-cleanup.job.ts`

```typescript
import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { OpenAICleanupService } from "../services/openai-cleanup.service";

@Injectable()
export class ThreadCleanupJob {
  private readonly logger = new Logger(ThreadCleanupJob.name);

  constructor(private readonly openaiCleanup: OpenAICleanupService) {}

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async handleCron() {
    this.logger.log("Starting orphaned thread cleanup...");

    try {
      const result = await this.openaiCleanup.cleanupOrphanedThreads();
      this.logger.log(`Cleanup complete: ${result.deleted} threads deleted`);
    } catch (error) {
      this.logger.error("Thread cleanup failed:", error);
    }
  }
}
```

**File:** `api/apps/cron/src/jobs/session-expiry.job.ts`

```typescript
import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { RedisCleanupService } from "../services/redis-cleanup.service";

@Injectable()
export class SessionExpiryJob {
  private readonly logger = new Logger(SessionExpiryJob.name);

  constructor(private readonly redisCleanup: RedisCleanupService) {}

  @Cron(CronExpression.EVERY_HOUR)
  async handleCron() {
    this.logger.log("Checking for stale sessions...");

    try {
      const result = await this.redisCleanup.expireStaleSessions();
      this.logger.log(`Session cleanup: ${result.expired} sessions expired`);
    } catch (error) {
      this.logger.error("Session expiry failed:", error);
    }
  }
}
```

**File:** `api/apps/cron/src/jobs/health-check.job.ts`

```typescript
import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { ConfigService } from "@nestjs/config";
import OpenAI from "openai";
import Redis from "ioredis";

@Injectable()
export class HealthCheckJob {
  private readonly logger = new Logger(HealthCheckJob.name);
  private openai: OpenAI;
  private redis: Redis;

  constructor(private configService: ConfigService) {
    this.openai = new OpenAI({
      apiKey: this.configService.get("OPENAI_API_KEY"),
    });
    this.redis = new Redis({
      host: this.configService.get("REDIS_HOST"),
      port: this.configService.get("REDIS_PORT"),
    });
  }

  @Cron(CronExpression.EVERY_5_MINUTES)
  async handleCron() {
    const status = {
      openai: await this.checkOpenAI(),
      redis: await this.checkRedis(),
      timestamp: new Date().toISOString(),
    };

    if (!status.openai || !status.redis) {
      this.logger.error("Health check failed:", status);
    } else {
      this.logger.debug("Health check passed");
    }

    // Store status in Redis for monitoring
    await this.redis.set(
      "ai-match:health-status",
      JSON.stringify(status),
      "EX",
      600 // 10 minutes TTL
    );
  }

  private async checkOpenAI(): Promise<boolean> {
    try {
      await this.openai.models.list();
      return true;
    } catch {
      return false;
    }
  }

  private async checkRedis(): Promise<boolean> {
    try {
      await this.redis.ping();
      return true;
    } catch {
      return false;
    }
  }
}
```

### 9. Docker Configuration

**File:** `api/docker-compose.yml`

```yaml
version: '3.8'

services:
  # Main API Service
  main-api:
    build:
      context: .
      dockerfile: apps/api/Dockerfile
    ports:
      - "4000:4000"
    environment:
      - NODE_ENV=development
      - DATABASE_URL=postgresql://postgres:postgres@postgres:5432/devmatch
      - REDIS_HOST=redis
      - REDIS_PORT=6379
      - AI_AGENT_URL=http://ai-agent:4001
    depends_on:
      - postgres
      - redis
      - ai-agent
    networks:
      - devmatch-network

  # AI Agent Service
  ai-agent:
    build:
      context: .
      dockerfile: apps/ai-agent/Dockerfile
    ports:
      - "4001:4001"
    environment:
      - NODE_ENV=development
      - DATABASE_URL=postgresql://postgres:postgres@postgres:5432/devmatch
      - REDIS_HOST=redis
      - REDIS_PORT=6379
      - OPENAI_API_KEY=${OPENAI_API_KEY}
      - OPENAI_ASSISTANT_ID=${OPENAI_ASSISTANT_ID}
    depends_on:
      - postgres
      - redis
    networks:
      - devmatch-network

  # Cron Service
  cron:
    build:
      context: .
      dockerfile: apps/cron/Dockerfile
    environment:
      - NODE_ENV=development
      - DATABASE_URL=postgresql://postgres:postgres@postgres:5432/devmatch
      - REDIS_HOST=redis
      - REDIS_PORT=6379
      - OPENAI_API_KEY=${OPENAI_API_KEY}
    depends_on:
      - postgres
      - redis
    networks:
      - devmatch-network
    # No ports - runs internally

  # PostgreSQL
  postgres:
    image: postgres:15-alpine
    ports:
      - "5432:5432"
    environment:
      - POSTGRES_DB=devmatch
      - POSTGRES_USER=postgres
      - POSTGRES_PASSWORD=postgres
    volumes:
      - postgres-data:/var/lib/postgresql/data
    networks:
      - devmatch-network

  # Redis
  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
    volumes:
      - redis-data:/data
    networks:
      - devmatch-network

networks:
  devmatch-network:
    driver: bridge

volumes:
  postgres-data:
  redis-data:
```

**File:** `api/apps/ai-agent/Dockerfile`

```dockerfile
FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
COPY nest-cli.json ./
COPY tsconfig*.json ./
COPY apps/ai-agent ./apps/ai-agent
COPY libs ./libs

RUN npm ci
RUN npm run build ai-agent

FROM node:20-alpine

WORKDIR /app

COPY --from=builder /app/dist/apps/ai-agent ./dist
COPY --from=builder /app/node_modules ./node_modules

EXPOSE 4001

CMD ["node", "dist/main.js"]
```

**File:** `api/apps/cron/Dockerfile`

```dockerfile
FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
COPY nest-cli.json ./
COPY tsconfig*.json ./
COPY apps/cron ./apps/cron
COPY libs ./libs

RUN npm ci
RUN npm run build cron

FROM node:20-alpine

WORKDIR /app

COPY --from=builder /app/dist/apps/cron ./dist
COPY --from=builder /app/node_modules ./node_modules

CMD ["node", "dist/main.js"]
```

### 10. OpenAI Agent Service (AI Agent Microservice)

**File:** `api/apps/ai-agent/src/openai/openai-agent.service.ts`

```typescript
import { Injectable, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import OpenAI from "openai";
import { ASSISTANT_INSTRUCTIONS } from "./assistant-config";
import { TOOL_DEFINITIONS } from "./tools/tool-definitions";
import { ToolHandlers } from "./tools/tool-handlers";
import { EventPublisherService } from "../events/event-publisher.service";
import { AIMatchEventType, createEvent } from "@app/shared/types/event.types";

@Injectable()
export class OpenAIAgentService implements OnModuleInit {
  private openai: OpenAI;
  private assistantId: string;

  constructor(
    private configService: ConfigService,
    private toolHandlers: ToolHandlers,
    private pubsubService: EventPublisherService
  ) {
    this.openai = new OpenAI({
      apiKey: this.configService.get("OPENAI_API_KEY"),
    });
  }

  async onModuleInit() {
    await this.initializeAssistant();
    await this.healthCheck();
  }

  private async initializeAssistant() {
    const existingAssistantId = this.configService.get("OPENAI_ASSISTANT_ID");

    try {
      if (existingAssistantId) {
        this.assistantId = existingAssistantId;
        await this.openai.beta.assistants.update(this.assistantId, {
          instructions: ASSISTANT_INSTRUCTIONS,
          tools: TOOL_DEFINITIONS,
          model: "gpt-4o",
        });
        console.log(`Updated existing assistant: ${this.assistantId}`);
      } else {
        const assistant = await this.openai.beta.assistants.create({
          name: "DevMatch Recruiter Assistant",
          instructions: ASSISTANT_INSTRUCTIONS,
          tools: TOOL_DEFINITIONS,
          model: "gpt-4o",
        });
        this.assistantId = assistant.id;
        console.log(`Created new assistant: ${this.assistantId}`);
        console.warn(
          `⚠️ Save this assistant ID to OPENAI_ASSISTANT_ID env var: ${this.assistantId}`
        );
      }
    } catch (error) {
      console.error("Failed to initialize OpenAI assistant:", error);
      throw new Error(
        "OpenAI assistant initialization failed. Check OPENAI_API_KEY and permissions."
      );
    }
  }

  /**
   * Verify OpenAI API connectivity and assistant availability
   */
  async healthCheck(): Promise<{ healthy: boolean; openaiStatus: string }> {
    try {
      const assistant = await this.openai.beta.assistants.retrieve(this.assistantId);
      console.log(`✅ OpenAI health check passed. Assistant: ${assistant.name}`);
      return { healthy: true, openaiStatus: "connected" };
    } catch (error) {
      console.error("❌ OpenAI health check failed:", error);
      return { healthy: false, openaiStatus: "disconnected" };
    }
  }

  /**
   * Get existing thread or create a new one
   */
  async getOrCreateThread(existingThreadId?: string): Promise<string> {
    if (existingThreadId) {
      return existingThreadId;
    }
    const thread = await this.openai.beta.threads.create();
    return thread.id;
  }

  /**
   * Run the matching agent with streaming events published to Redis
   */
  async runMatchingAgentStreaming(
    sessionId: string,
    messageId: string,
    prompt: string,
    threadId: string,
    excludeDeveloperIds?: string[],
    maxResults?: number
  ): Promise<void> {
    // Emit thinking event
    await this.emitEvent(sessionId, messageId, AIMatchEventType.THINKING, {
      message: "Analyzing your request...",
    });

    // Add user message to thread
    await this.openai.beta.threads.messages.create(threadId, {
      role: "user",
      content: this.buildUserPrompt(prompt, excludeDeveloperIds, maxResults),
    });

    // Create and stream the run
    const stream = this.openai.beta.threads.runs.stream(threadId, {
      assistant_id: this.assistantId,
    });

    // Track current run for cancellation via Redis
    stream.on("run", async (run) => {
      await this.pubsubService.publishRunStarted(sessionId, run.id);
    });

    // Handle streaming events with error handling
    try {
      for await (const event of stream) {
        await this.handleStreamEvent(sessionId, messageId, threadId, event);
      }
    } catch (streamError) {
      console.error("Stream error:", streamError);
      await this.emitEvent(sessionId, messageId, AIMatchEventType.ERROR, {
        errorMessage: streamError instanceof Error ? streamError.message : "Stream interrupted",
      });
    }
  }

  private async handleStreamEvent(
    sessionId: string,
    messageId: string,
    threadId: string,
    event: any
  ): Promise<void> {
    try {
      switch (event.event) {
        case "thread.run.requires_action":
          await this.handleToolCallsStreaming(
            sessionId,
            messageId,
            threadId,
            event.data
          );
          break;

        case "thread.message.delta":
          // Handle streaming text (for final response)
          const delta = event.data.delta;
          if (delta.content?.[0]?.text?.value) {
            // Parse and emit matches as they come
            await this.parseAndEmitMatches(
              sessionId,
              messageId,
              delta.content[0].text.value
            );
          }
          break;

        case "thread.run.completed":
          await this.handleRunCompleted(sessionId, messageId, threadId);
          break;

        case "thread.run.failed":
          await this.emitEvent(sessionId, messageId, AIMatchEventType.ERROR, {
            errorMessage: event.data.last_error?.message || "Run failed",
          });
          break;

        case "thread.run.cancelled":
          await this.emitEvent(sessionId, messageId, AIMatchEventType.CANCELLED, {
            reason: "run_cancelled",
          });
          break;
      }
    } catch (eventError) {
      console.error(`Error handling event ${event.event}:`, eventError);
      // Don't break the stream loop for individual event errors
    }
  }

  private async handleToolCallsStreaming(
    sessionId: string,
    messageId: string,
    threadId: string,
    run: OpenAI.Beta.Threads.Runs.Run
  ): Promise<void> {
    const toolCalls = run.required_action?.submit_tool_outputs?.tool_calls;
    if (!toolCalls) return;

    const toolOutputs = await Promise.all(
      toolCalls.map(async (toolCall) => {
        const toolName = toolCall.function.name;
        const args = JSON.parse(toolCall.function.arguments);

        // Emit tool call event
        await this.emitEvent(sessionId, messageId, AIMatchEventType.TOOL_CALL, {
          toolName,
          toolArgs: args,
        });

        // Execute tool
        const result = await this.toolHandlers.execute(toolName, args);

        // Emit tool result event
        await this.emitEvent(sessionId, messageId, AIMatchEventType.TOOL_RESULT, {
          toolName,
          resultSummary: this.summarizeToolResult(toolName, result),
          candidateCount: Array.isArray(result) ? result.length : undefined,
        });

        return {
          tool_call_id: toolCall.id,
          output: JSON.stringify(result),
        };
      })
    );

    // Submit tool outputs (streaming continues automatically)
    await this.openai.beta.threads.runs.submitToolOutputsStream(
      threadId,
      run.id,
      { tool_outputs: toolOutputs }
    );
  }

  private async handleRunCompleted(
    sessionId: string,
    messageId: string,
    threadId: string
  ): Promise<void> {
    // Get the final message
    const messages = await this.openai.beta.threads.messages.list(threadId, {
      order: "desc",
      limit: 1,
    });

    const lastMessage = messages.data[0];
    const content = lastMessage.content[0];

    if (content.type === "text") {
      try {
        const response = JSON.parse(content.text.value);

        // Emit individual matches
        for (const match of response.matches || []) {
          await this.emitEvent(sessionId, messageId, AIMatchEventType.MATCH_FOUND, {
            match,
          });
        }

        // Emit completion
        await this.emitEvent(sessionId, messageId, AIMatchEventType.COMPLETE, {
          summary: response.searchSummary,
          totalMatches: response.matches?.length || 0,
          totalCandidates: response.totalCandidates || 0,
          isOffTopic: response.isOffTopic || false,
        });
      } catch (e) {
        await this.emitEvent(sessionId, messageId, AIMatchEventType.ERROR, {
          errorMessage: "Failed to parse agent response",
        });
      }
    }
  }

  /**
   * Cancel a running OpenAI run
   */
  async cancelRun(threadId: string, runId: string): Promise<boolean> {
    try {
      await this.openai.beta.threads.runs.cancel(threadId, runId);
      return true;
    } catch (e) {
      console.error("Failed to cancel run:", e);
      return false;
    }
  }

  private async emitEvent(
    sessionId: string,
    messageId: string,
    type: AIMatchEventType,
    data?: Record<string, any>
  ): Promise<void> {
    await this.pubsubService.publish(
      sessionId,
      createEvent(type, sessionId, messageId, data)
    );
  }

  private buildUserPrompt(
    prompt: string,
    excludeIds?: string[],
    maxResults?: number
  ): string {
    let userPrompt = `Find developers matching: "${prompt}"`;
    if (excludeIds?.length) {
      userPrompt += `\n\nExclude these developer IDs: ${excludeIds.join(", ")}`;
    }
    if (maxResults) {
      userPrompt += `\n\nReturn at most ${maxResults} matches.`;
    }
    userPrompt += `\n\nUse the available tools to search and analyze developers, then return the best matches.`;
    return userPrompt;
  }

  private summarizeToolResult(toolName: string, result: any): string {
    switch (toolName) {
      case "search_developers":
        return `Found ${result.length} developers matching criteria`;
      case "get_developer_details":
        return result ? `Retrieved profile for ${result.firstName} ${result.lastName}` : "Developer not found";
      case "get_available_tech_stack":
        return `${result.length} technologies available`;
      case "get_developer_statistics":
        return `${result.total} developers in database`;
      default:
        return "Tool executed";
    }
  }

  private async parseAndEmitMatches(
    sessionId: string,
    messageId: string,
    partialText: string
  ): Promise<void> {
    // This is called during streaming - we accumulate and parse when complete
    // For now, just emit thinking updates
    // Full parsing happens in handleRunCompleted
  }
}
```

### 11. Event Publisher Service (AI Agent Microservice)

**File:** `api/apps/ai-agent/src/events/event-publisher.service.ts`

```typescript
import { Injectable, OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import Redis from "ioredis";
import { AIMatchEvent, AIMatchEventType, createEvent } from "@app/shared/types/event.types";

@Injectable()
export class EventPublisherService implements OnModuleDestroy {
  private redis: Redis;

  constructor(private configService: ConfigService) {
    this.redis = new Redis({
      host: this.configService.get("REDIS_HOST"),
      port: this.configService.get("REDIS_PORT"),
    });
  }

  async publish(sessionId: string, event: AIMatchEvent): Promise<void> {
    await this.redis.publish(`ai-match:${sessionId}`, JSON.stringify(event));
  }

  async publishRunStarted(sessionId: string, runId: string): Promise<void> {
    // Store run ID for cancellation lookup
    await this.redis.set(`ai-match:run:${sessionId}`, runId, "EX", 3600);
  }

  async publishError(
    sessionId: string,
    messageId: string,
    errorMessage: string
  ): Promise<void> {
    await this.publish(
      sessionId,
      createEvent(AIMatchEventType.ERROR, sessionId, messageId, { errorMessage })
    );
  }

  async onModuleDestroy() {
    await this.redis.quit();
  }
}
```

### 12. Shared Types

**File:** `api/libs/shared/src/types/event.types.ts`

```typescript
export enum AIMatchEventType {
  CONNECTED = "CONNECTED",
  MESSAGE_QUEUED = "MESSAGE_QUEUED",
  MESSAGE_STARTED = "MESSAGE_STARTED",
  THINKING = "THINKING",
  TOOL_CALL = "TOOL_CALL",
  TOOL_RESULT = "TOOL_RESULT",
  MATCH_FOUND = "MATCH_FOUND",
  COMPLETE = "COMPLETE",
  ERROR = "ERROR",
  CANCELLED = "CANCELLED",
  RATE_LIMITED = "RATE_LIMITED",
}

export interface AIMatchEvent {
  type: AIMatchEventType;
  sessionId: string;
  messageId: string;
  timestamp: string;
  data?: Record<string, any>;
}

export function createEvent(
  type: AIMatchEventType,
  sessionId: string,
  messageId: string,
  data?: Record<string, any>
): AIMatchEvent {
  return {
    type,
    sessionId,
    messageId,
    timestamp: new Date().toISOString(),
    data,
  };
}
```

**File:** `api/libs/shared/src/types/agent.types.ts`

```typescript
export interface AgentMatchResult {
  developerId: string;
  matchScore: number;
  matchReason: string;
}

export interface AgentResponse {
  response: {
    matches: AgentMatchResult[];
    searchSummary: string;
    totalCandidates: number;
  };
  threadId: string;
}

export interface DeveloperSearchParams {
  techStack?: string[];
  seniorityLevels?: string[];
  location?: string;
  availabilityStatus?: string[];
  searchText?: string;
  excludeIds?: string[];
  limit?: number;
}

export interface DeveloperProfile {
  id: string;
  firstName: string;
  lastName: string;
  jobTitle: string;
  bio: string;
  techStack: string[];
  seniorityLevel: string;
  location: string;
  availabilityStatus: string;
  experiences: {
    companyName: string;
    position: string;
    yearsWorked: number;
  }[];
  projects: {
    name: string;
    techStack: string[];
  }[];
}
```

### 6. Assistant Configuration

**File:** `api/apps/api/src/ai-match/agent/assistant-config.ts`

```typescript
export const ASSISTANT_INSTRUCTIONS = `You are a talent matching assistant for DevMatch, a developer hiring platform.

Your role is to help users find the best developer matches based on their natural language requirements.

## IMPORTANT: Scope Restriction

You are ONLY designed to help find developers. Before processing any request:

1. **Check if the request is about finding/searching developers**
2. **If NOT related to developer search**, respond with:
\`\`\`json
{
  "matches": [],
  "searchSummary": "I'm designed specifically to help you find developers. Please describe the type of developer you're looking for - including skills, experience level, location, or technologies you need.",
  "totalCandidates": 0,
  "isOffTopic": true
}
\`\`\`

Examples of OFF-TOPIC requests (reject these):
- General questions ("What's the weather?", "Tell me a joke")
- Non-developer searches ("Find me a designer", "I need a lawyer")
- Coding help ("How do I write a React component?")
- Career advice ("How do I become a developer?")

Examples of VALID requests (process these):
- "Senior React developer with AWS experience"
- "Find backend engineers who know Python and Django"
- "Mobile developers available for remote work"
- "Full-stack developer in New York"

## How to Process Valid Requests

1. **Analyze the Request**: Parse the requirements to understand:
   - Required technologies and frameworks
   - Seniority level expectations
   - Location preferences
   - Availability requirements
   - Any specific domain expertise needed

2. **Search Developers**: Use the \`search_developers\` tool to find candidates matching the criteria.
   - Start with broader searches, then refine if needed
   - You can make multiple search calls with different criteria

3. **Get Developer Details**: Use \`get_developer_details\` for promising candidates to see full profiles.

4. **Analyze & Score**: For each potential match:
   - Evaluate technical skills alignment
   - Consider seniority fit
   - Review relevant experience and projects
   - Assess overall profile strength

5. **Return Results**: Always return your final response as a JSON object:
\`\`\`json
{
  "matches": [
    {
      "developerId": "uuid",
      "matchScore": 85,
      "matchReason": "Specific explanation of why they match (2-3 sentences)"
    }
  ],
  "searchSummary": "Brief summary of what you searched for and found",
  "totalCandidates": 25,
  "isOffTopic": false
}
\`\`\`

## Scoring Guidelines

- **90-100**: Perfect match - all key requirements met, strong experience
- **75-89**: Strong match - most requirements met, relevant background
- **60-74**: Good match - core skills present, some gaps
- **Below 60**: Partial match - consider only if few candidates

## Important Rules

- NEVER process off-topic requests - always check scope first
- Always use tools to get real data - never make up developer information
- Be specific in match reasons - mention actual skills/projects from their profile
- Limit results to the top 10 matches unless asked otherwise
- If no good matches found, explain why and suggest broadening criteria`;
```

### 7. Tool Definitions (Function Calling)

**File:** `api/apps/api/src/ai-match/agent/tools/tool-definitions.ts`

```typescript
import { AssistantTool } from "openai/resources/beta/assistants";

export const TOOL_DEFINITIONS: AssistantTool[] = [
  {
    type: "function",
    function: {
      name: "search_developers",
      description:
        "Search for developers in the database based on various criteria. Returns a list of matching developer profiles.",
      parameters: {
        type: "object",
        properties: {
          techStack: {
            type: "array",
            items: { type: "string" },
            description:
              "Technologies to filter by (e.g., ['React', 'Node.js', 'TypeScript'])",
          },
          seniorityLevels: {
            type: "array",
            items: {
              type: "string",
              enum: ["Junior", "Mid", "Senior", "Lead", "Principal"],
            },
            description: "Seniority levels to include",
          },
          location: {
            type: "string",
            description:
              "Location filter (supports partial match, e.g., 'San Francisco' or 'Remote')",
          },
          availabilityStatus: {
            type: "array",
            items: {
              type: "string",
              enum: ["Available", "OpenToOffers", "NotAvailable"],
            },
            description: "Filter by availability status",
          },
          searchText: {
            type: "string",
            description:
              "Free text search across name, job title, and bio",
          },
          excludeIds: {
            type: "array",
            items: { type: "string" },
            description: "Developer IDs to exclude from results",
          },
          limit: {
            type: "number",
            description: "Maximum number of results (default: 20, max: 50)",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_developer_details",
      description:
        "Get full profile details for a specific developer including all experiences and projects.",
      parameters: {
        type: "object",
        properties: {
          developerId: {
            type: "string",
            description: "The UUID of the developer to retrieve",
          },
        },
        required: ["developerId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_available_tech_stack",
      description:
        "Get a list of all unique technologies in the database. Useful for understanding what skills are available.",
      parameters: {
        type: "object",
        properties: {},
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_developer_statistics",
      description:
        "Get statistics about developers in the database (counts by seniority, location, etc.)",
      parameters: {
        type: "object",
        properties: {},
      },
    },
  },
];
```

### 8. Tool Handlers (Execute Function Calls)

**File:** `api/apps/api/src/ai-match/agent/tools/tool-handlers.ts`

```typescript
import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { Developer } from "../../../developer/developer.entity";
import { DeveloperSearchParams, DeveloperProfile } from "../agent.types";

@Injectable()
export class ToolHandlers {
  constructor(
    @InjectRepository(Developer)
    private developerRepository: Repository<Developer>
  ) {}

  async execute(toolName: string, args: any): Promise<any> {
    switch (toolName) {
      case "search_developers":
        return this.searchDevelopers(args);
      case "get_developer_details":
        return this.getDeveloperDetails(args.developerId);
      case "get_available_tech_stack":
        return this.getAvailableTechStack();
      case "get_developer_statistics":
        return this.getDeveloperStatistics();
      default:
        throw new Error(`Unknown tool: ${toolName}`);
    }
  }

  private async searchDevelopers(
    params: DeveloperSearchParams
  ): Promise<DeveloperProfile[]> {
    const query = this.developerRepository
      .createQueryBuilder("developer")
      .leftJoinAndSelect("developer.user", "user")
      .leftJoinAndSelect("developer.experiences", "experiences")
      .leftJoinAndSelect("developer.projects", "projects")
      .where("user.deletedAt IS NULL")
      .andWhere("developer.onboardingCompleted = :completed", {
        completed: true,
      });

    if (params.techStack?.length) {
      query.andWhere("developer.techStack && :techStack", {
        techStack: params.techStack,
      });
    }

    if (params.seniorityLevels?.length) {
      query.andWhere("developer.seniorityLevel IN (:...levels)", {
        levels: params.seniorityLevels,
      });
    }

    if (params.location) {
      query.andWhere("developer.location ILIKE :location", {
        location: `%${params.location}%`,
      });
    }

    if (params.availabilityStatus?.length) {
      query.andWhere("developer.availabilityStatus IN (:...statuses)", {
        statuses: params.availabilityStatus,
      });
    }

    if (params.searchText) {
      query.andWhere(
        "(developer.firstName ILIKE :search OR developer.lastName ILIKE :search OR developer.jobTitle ILIKE :search OR developer.bio ILIKE :search)",
        { search: `%${params.searchText}%` }
      );
    }

    if (params.excludeIds?.length) {
      query.andWhere("developer.id NOT IN (:...excludeIds)", {
        excludeIds: params.excludeIds,
      });
    }

    const limit = Math.min(params.limit || 20, 50);
    const developers = await query.take(limit).getMany();

    return developers.map((dev) => this.mapToDeveloperProfile(dev));
  }

  private async getDeveloperDetails(
    developerId: string
  ): Promise<DeveloperProfile | null> {
    const developer = await this.developerRepository.findOne({
      where: { id: developerId },
      relations: ["user", "experiences", "projects", "profilePhoto"],
    });

    if (!developer) return null;
    return this.mapToDeveloperProfile(developer);
  }

  private async getAvailableTechStack(): Promise<string[]> {
    const result = await this.developerRepository
      .createQueryBuilder("developer")
      .select("DISTINCT unnest(developer.techStack)", "tech")
      .orderBy("tech", "ASC")
      .getRawMany();

    return result.map((r) => r.tech);
  }

  private async getDeveloperStatistics(): Promise<{
    total: number;
    bySeniority: Record<string, number>;
    byAvailability: Record<string, number>;
    topTechnologies: { tech: string; count: number }[];
  }> {
    const total = await this.developerRepository.count({
      where: { onboardingCompleted: true },
    });

    const bySeniority = await this.developerRepository
      .createQueryBuilder("developer")
      .select("developer.seniorityLevel", "level")
      .addSelect("COUNT(*)", "count")
      .where("developer.onboardingCompleted = true")
      .groupBy("developer.seniorityLevel")
      .getRawMany();

    const byAvailability = await this.developerRepository
      .createQueryBuilder("developer")
      .select("developer.availabilityStatus", "status")
      .addSelect("COUNT(*)", "count")
      .where("developer.onboardingCompleted = true")
      .groupBy("developer.availabilityStatus")
      .getRawMany();

    const topTech = await this.developerRepository
      .createQueryBuilder("developer")
      .select("unnest(developer.techStack)", "tech")
      .addSelect("COUNT(*)", "count")
      .where("developer.onboardingCompleted = true")
      .groupBy("tech")
      .orderBy("count", "DESC")
      .limit(20)
      .getRawMany();

    return {
      total,
      bySeniority: Object.fromEntries(bySeniority.map((r) => [r.level, +r.count])),
      byAvailability: Object.fromEntries(
        byAvailability.map((r) => [r.status, +r.count])
      ),
      topTechnologies: topTech.map((r) => ({ tech: r.tech, count: +r.count })),
    };
  }

  private mapToDeveloperProfile(developer: Developer): DeveloperProfile {
    const currentYear = new Date().getFullYear();
    return {
      id: developer.id,
      firstName: developer.firstName,
      lastName: developer.lastName,
      jobTitle: developer.jobTitle,
      bio: developer.bio,
      techStack: developer.techStack || [],
      seniorityLevel: developer.seniorityLevel,
      location: developer.location,
      availabilityStatus: developer.availabilityStatus,
      experiences:
        developer.experiences?.map((exp) => ({
          companyName: exp.companyName,
          position: exp.position,
          yearsWorked: exp.endYear
            ? exp.endYear - exp.startYear
            : currentYear - exp.startYear,
        })) || [],
      projects:
        developer.projects?.map((proj) => ({
          name: proj.name,
          techStack: proj.techStack || [],
        })) || [],
    };
  }
}
```

### 9. AI Match Service (Orchestrates Queue & HTTP Client)

**File:** `api/apps/api/src/ai-match/ai-match.service.ts`

```typescript
import { Injectable, Logger } from "@nestjs/common";
import { AIAgentClient } from "./http/ai-agent.client";
import { MessageQueueService } from "./queue/message-queue.service";
import { SessionService } from "./session/session.service";
import { PubSubService } from "./streaming/pubsub.service";
import { AIMatchEventType, createEvent } from "@app/shared/types/event.types";

@Injectable()
export class AIMatchService {
  private readonly logger = new Logger(AIMatchService.name);
  // Track active processors per session to prevent race conditions
  private activeProcessors = new Set<string>();

  constructor(
    private aiAgentClient: AIAgentClient,
    private messageQueueService: MessageQueueService,
    private sessionService: SessionService,
    private pubsubService: PubSubService
  ) {}

  /**
   * Process the message queue for a session.
   * Uses a lock to ensure only one processor runs per session at a time.
   */
  async processQueue(sessionId: string): Promise<void> {
    // Prevent concurrent processors for the same session
    if (this.activeProcessors.has(sessionId)) {
      return; // Another processor is already running
    }

    this.activeProcessors.add(sessionId);

    try {
      while (true) {
        const nextMessage = await this.messageQueueService.getNextMessage(sessionId);
        if (!nextMessage) {
          break; // Queue is empty
        }

        await this.processMessage(sessionId, nextMessage.messageId, nextMessage.prompt);
      }
    } finally {
      this.activeProcessors.delete(sessionId);
    }
  }

  /**
   * Process a single message by calling AI Agent microservice
   */
  private async processMessage(
    sessionId: string,
    messageId: string,
    prompt: string
  ): Promise<void> {
    try {
      // Mark message as started
      await this.messageQueueService.markMessageStarted(sessionId, messageId);

      // Update queue positions for remaining messages
      await this.broadcastQueuePositions(sessionId);

      // Get session for threadId
      const session = await this.sessionService.getSession(sessionId);

      // Call AI Agent microservice via HTTP
      // The service will publish events to Redis as it processes
      const response = await this.aiAgentClient.runMatchingAgent({
        sessionId,
        messageId,
        prompt,
        threadId: session?.threadId || undefined,
        maxResults: 10,
      });

      // Update threadId if returned (for conversation continuity)
      if (response.threadId && response.threadId !== session?.threadId) {
        await this.sessionService.setThreadId(sessionId, response.threadId);
      }

      // Mark message as completed
      await this.messageQueueService.markMessageCompleted(sessionId, messageId);
    } catch (error) {
      this.logger.error(`Failed to process message ${messageId}:`, error);
      // Mark message as failed and emit error
      await this.messageQueueService.markMessageFailed(sessionId, messageId);
      await this.pubsubService.publish(
        sessionId,
        createEvent(AIMatchEventType.ERROR, sessionId, messageId, {
          errorMessage: error instanceof Error ? error.message : "Processing failed",
        })
      );
    }
  }

  /**
   * Broadcast updated queue positions to all waiting messages
   */
  private async broadcastQueuePositions(sessionId: string): Promise<void> {
    const status = await this.messageQueueService.getQueueStatus(sessionId);

    status.queued.forEach((msg, index) => {
      this.pubsubService.publish(
        sessionId,
        createEvent(AIMatchEventType.MESSAGE_QUEUED, sessionId, msg.messageId, {
          position: index + 1,
          prompt: msg.prompt,
        })
      );
    });
  }

  /**
   * Cancel the currently running OpenAI run
   */
  async cancelCurrentRun(sessionId: string): Promise<boolean> {
    const session = await this.sessionService.getSession(sessionId);
    if (!session?.threadId) {
      return false;
    }

    // Get runId from Redis (stored by AI Agent service)
    const runId = await this.sessionService.getCurrentRunId(sessionId);
    if (!runId) {
      return false;
    }

    try {
      const response = await this.aiAgentClient.cancelRun({
        sessionId,
        threadId: session.threadId,
        runId,
      });

      if (response.success) {
        const processing = session.messageQueue?.find(m => m.status === 'processing');
        if (processing) {
          await this.messageQueueService.markMessageCancelled(sessionId, processing.messageId);
        }
      }

      return response.success;
    } catch (error) {
      this.logger.error(`Failed to cancel run for session ${sessionId}:`, error);
      return false;
    }
  }
}

### 10. Pub/Sub Service (Streaming)

**File:** `api/apps/api/src/ai-match/streaming/pubsub.service.ts`

```typescript
import { Injectable, OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { RedisPubSub } from "graphql-redis-subscriptions";
import Redis from "ioredis";
import { AIMatchEvent } from "@app/shared/types/event.types";

@Injectable()
export class PubSubService implements OnModuleDestroy {
  private pubsub: RedisPubSub;

  constructor(private configService: ConfigService) {
    const redisOptions = {
      host: this.configService.get("REDIS_HOST"),
      port: this.configService.get("REDIS_PORT"),
    };

    this.pubsub = new RedisPubSub({
      publisher: new Redis(redisOptions),
      subscriber: new Redis(redisOptions),
    });
  }

  async publish(sessionId: string, event: AIMatchEvent): Promise<void> {
    await this.pubsub.publish(`ai-match:${sessionId}`, event);
  }

  subscribe(sessionId: string): AsyncIterator<AIMatchEvent> {
    return this.pubsub.asyncIterator(`ai-match:${sessionId}`);
  }

  async onModuleDestroy() {
    await this.pubsub.close();
  }
}
```

**Note:** Event types are imported from `@app/shared/types/event.types` (see Section 12).

### 11. Session Service

**File:** `api/apps/api/src/ai-match/session/session.service.ts`

```typescript
import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import Redis from "ioredis";
import { v4 as uuidv4 } from "uuid";
import { SessionState, QueuedMessage } from "./session.types";

@Injectable()
export class SessionService {
  private redis: Redis;
  private readonly SESSION_TTL = 60 * 60 * 24; // 24 hours

  constructor(private configService: ConfigService) {
    this.redis = new Redis({
      host: this.configService.get("REDIS_HOST"),
      port: this.configService.get("REDIS_PORT"),
    });
  }

  async getOrCreateSession(
    sessionId: string | null,
    userId: string | null
  ): Promise<SessionState> {
    if (sessionId) {
      const existing = await this.getSession(sessionId);
      if (existing) {
        await this.touchSession(sessionId);
        return existing;
      }
    }

    // Create new session
    const newSessionId = sessionId || uuidv4();
    const session: SessionState = {
      sessionId: newSessionId,
      userId,
      threadId: null,
      messageQueue: [],
      createdAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
    };

    await this.saveSession(session);
    return session;
  }

  async getSession(sessionId: string): Promise<SessionState | null> {
    const data = await this.redis.get(`ai-match:session:${sessionId}`);
    return data ? JSON.parse(data) : null;
  }

  async saveSession(session: SessionState): Promise<void> {
    session.lastActivityAt = new Date().toISOString();
    await this.redis.setex(
      `ai-match:session:${session.sessionId}`,
      this.SESSION_TTL,
      JSON.stringify(session)
    );
  }

  async touchSession(sessionId: string): Promise<void> {
    await this.redis.expire(`ai-match:session:${sessionId}`, this.SESSION_TTL);
  }

  async setThreadId(sessionId: string, threadId: string): Promise<void> {
    const session = await this.getSession(sessionId);
    if (session) {
      session.threadId = threadId;
      await this.saveSession(session);
    }
  }

  /**
   * Get current run ID from Redis (stored by AI Agent service)
   */
  async getCurrentRunId(sessionId: string): Promise<string | null> {
    return this.redis.get(`ai-match:run:${sessionId}`);
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.redis.del(`ai-match:session:${sessionId}`);
  }
}
```

### 12. Message Queue Service

**File:** `api/apps/api/src/ai-match/queue/message-queue.service.ts`

```typescript
import { Injectable } from "@nestjs/common";
import { v4 as uuidv4 } from "uuid";
import { SessionService } from "../session/session.service";
import { PubSubService } from "../streaming/pubsub.service";
import { AIMatchEventType, createEvent } from "@app/shared/types/event.types";
import { QueuedMessage } from "./queue.types";

@Injectable()
export class MessageQueueService {
  constructor(
    private sessionService: SessionService,
    private pubsubService: PubSubService
  ) {}

  async enqueueMessage(
    sessionId: string,
    prompt: string
  ): Promise<QueuedMessage> {
    const session = await this.sessionService.getSession(sessionId);
    if (!session) {
      throw new Error("Session not found");
    }

    const message: QueuedMessage = {
      messageId: uuidv4(),
      prompt,
      status: "queued",
      queuedAt: new Date().toISOString(),
    };

    // Add to queue
    session.messageQueue.push(message);
    await this.sessionService.saveSession(session);

    // Emit queued event
    await this.pubsubService.publish(
      sessionId,
      createEvent(AIMatchEventType.MESSAGE_QUEUED, sessionId, message.messageId, {
        position: session.messageQueue.length,
        prompt: message.prompt,
      })
    );

    return message;
  }

  async getNextMessage(sessionId: string): Promise<QueuedMessage | null> {
    const session = await this.sessionService.getSession(sessionId);
    if (!session) return null;

    // Find first queued message
    return session.messageQueue.find((m) => m.status === "queued") || null;
  }

  async markMessageStarted(
    sessionId: string,
    messageId: string
  ): Promise<void> {
    const session = await this.sessionService.getSession(sessionId);
    if (!session) return;

    const message = session.messageQueue.find((m) => m.messageId === messageId);
    if (message) {
      message.status = "processing";
      message.startedAt = new Date().toISOString();
      await this.sessionService.saveSession(session);

      await this.pubsubService.publish(
        sessionId,
        createEvent(AIMatchEventType.MESSAGE_STARTED, sessionId, messageId, {
          prompt: message.prompt,
        })
      );
    }
  }

  async markMessageCompleted(
    sessionId: string,
    messageId: string
  ): Promise<void> {
    const session = await this.sessionService.getSession(sessionId);
    if (!session) return;

    const message = session.messageQueue.find((m) => m.messageId === messageId);
    if (message) {
      message.status = "completed";
      message.completedAt = new Date().toISOString();
      await this.sessionService.saveSession(session);
    }
  }

  async cancelMessage(
    sessionId: string,
    messageId: string
  ): Promise<boolean> {
    const session = await this.sessionService.getSession(sessionId);
    if (!session) return false;

    const message = session.messageQueue.find((m) => m.messageId === messageId);
    if (message && message.status === "queued") {
      message.status = "cancelled";
      await this.sessionService.saveSession(session);

      await this.pubsubService.publish(
        sessionId,
        createEvent(AIMatchEventType.CANCELLED, sessionId, messageId, {
          reason: "user_cancelled",
        })
      );
      return true;
    }
    return false;
  }

  async getQueueStatus(sessionId: string): Promise<{
    processing: QueuedMessage | null;
    queued: QueuedMessage[];
  }> {
    const session = await this.sessionService.getSession(sessionId);
    if (!session) {
      return { processing: null, queued: [] };
    }

    return {
      processing: session.messageQueue.find((m) => m.status === "processing") || null,
      queued: session.messageQueue.filter((m) => m.status === "queued"),
    };
  }

  async markMessageFailed(
    sessionId: string,
    messageId: string
  ): Promise<void> {
    const session = await this.sessionService.getSession(sessionId);
    if (!session) return;

    const message = session.messageQueue.find((m) => m.messageId === messageId);
    if (message) {
      message.status = "failed";
      message.completedAt = new Date().toISOString();
      await this.sessionService.saveSession(session);
    }
  }

  async markMessageCancelled(
    sessionId: string,
    messageId: string
  ): Promise<void> {
    const session = await this.sessionService.getSession(sessionId);
    if (!session) return;

    const message = session.messageQueue.find((m) => m.messageId === messageId);
    if (message && message.status === "processing") {
      message.status = "cancelled";
      message.completedAt = new Date().toISOString();
      await this.sessionService.saveSession(session);

      await this.pubsubService.publish(
        sessionId,
        createEvent(AIMatchEventType.CANCELLED, sessionId, messageId, {
          reason: "run_cancelled",
        })
      );
    }
  }
}
```

**File:** `api/apps/api/src/ai-match/queue/queue.types.ts`

```typescript
export interface QueuedMessage {
  messageId: string;
  prompt: string;
  status: "queued" | "processing" | "completed" | "failed" | "cancelled";
  queuedAt: string;
  startedAt?: string;
  completedAt?: string;
}

export interface QueueStatus {
  processing: QueuedMessage | null;
  queued: QueuedMessage[];
}
```

**File:** `api/apps/api/src/ai-match/session/session.types.ts`

```typescript
import { QueuedMessage } from "../queue/queue.types";

export interface SessionState {
  sessionId: string;
  userId: string | null;        // null for guests
  threadId: string | null;      // OpenAI thread ID
  messageQueue: QueuedMessage[];
  createdAt: string;
  lastActivityAt: string;
}

// Note: currentRunId is stored separately in Redis by AI Agent service
// at key: ai-match:run:${sessionId}

export interface GuestIdentifier {
  ip: string;
  fingerprint: string;
}
```

### 13. Session Cleanup Service (Cron Job)

Orphaned OpenAI threads should be cleaned up periodically. Redis sessions expire via TTL, but OpenAI threads remain indefinitely.

**File:** `api/apps/api/src/ai-match/session/session-cleanup.service.ts`

```typescript
import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { ConfigService } from "@nestjs/config";
import OpenAI from "openai";
import Redis from "ioredis";

@Injectable()
export class SessionCleanupService {
  private readonly logger = new Logger(SessionCleanupService.name);
  private openai: OpenAI;
  private redis: Redis;

  constructor(private configService: ConfigService) {
    this.openai = new OpenAI({
      apiKey: this.configService.get("OPENAI_API_KEY"),
    });
    this.redis = new Redis({
      host: this.configService.get("REDIS_HOST"),
      port: this.configService.get("REDIS_PORT"),
    });
  }

  /**
   * Run cleanup every day at 3 AM UTC
   * Deletes OpenAI threads that have no corresponding active session
   */
  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async cleanupOrphanedThreads(): Promise<void> {
    this.logger.log("Starting orphaned thread cleanup...");

    try {
      // Get all active session keys
      const sessionKeys = await this.redis.keys("ai-match:session:*");
      const activeThreadIds = new Set<string>();

      // Collect all active thread IDs
      for (const key of sessionKeys) {
        const sessionData = await this.redis.get(key);
        if (sessionData) {
          const session = JSON.parse(sessionData);
          if (session.threadId) {
            activeThreadIds.add(session.threadId);
          }
        }
      }

      // Get tracked threads from Redis (threads we've created)
      const trackedThreadsKey = "ai-match:tracked-threads";
      const trackedThreads = await this.redis.smembers(trackedThreadsKey);

      let deletedCount = 0;

      for (const threadId of trackedThreads) {
        if (!activeThreadIds.has(threadId)) {
          try {
            await this.openai.beta.threads.del(threadId);
            await this.redis.srem(trackedThreadsKey, threadId);
            deletedCount++;
          } catch (error) {
            // Thread may already be deleted or not exist
            this.logger.warn(`Failed to delete thread ${threadId}:`, error);
            await this.redis.srem(trackedThreadsKey, threadId);
          }
        }
      }

      this.logger.log(`Cleanup complete. Deleted ${deletedCount} orphaned threads.`);
    } catch (error) {
      this.logger.error("Thread cleanup failed:", error);
    }
  }
}
```

**Update OpenAI Agent Service to track created threads:**

Add to `openai-agent.service.ts` after creating a new thread:

```typescript
// Track thread for cleanup
await this.redis.sadd("ai-match:tracked-threads", thread.id);
```

**Register the cleanup service in the module:**

```typescript
import { ScheduleModule } from "@nestjs/schedule";
import { SessionCleanupService } from "./session/session-cleanup.service";

@Module({
  imports: [
    ScheduleModule.forRoot(),
    // ... other imports
  ],
  providers: [
    // ... other providers
    SessionCleanupService,
  ],
})
export class AIMatchModule {}
```

**Install dependency:**

```bash
npm install @nestjs/schedule
```

### 14. Rate Limit Service

**File:** `api/apps/api/src/ai-match/rate-limit/rate-limit.service.ts`

```typescript
import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import Redis from "ioredis";
import { RateLimitInfo, UserType } from "./rate-limit.types";

@Injectable()
export class RateLimitService {
  private redis: Redis;

  // Rate limits by user type
  private readonly LIMITS = {
    guest: { maxRequests: 3, maxResults: 5 },
    authenticated: { maxRequests: 20, maxResults: 10 },
    recruiter: { maxRequests: -1, maxResults: 10 }, // -1 = unlimited
  };

  constructor(private configService: ConfigService) {
    this.redis = new Redis({
      host: this.configService.get("REDIS_HOST"),
      port: this.configService.get("REDIS_PORT"),
    });
  }

  async checkAndIncrement(
    identifier: string,
    userType: UserType
  ): Promise<{ allowed: boolean; info: RateLimitInfo }> {
    const limit = this.LIMITS[userType];

    // Unlimited for paid recruiters
    if (limit.maxRequests === -1) {
      return {
        allowed: true,
        info: { remaining: -1, limit: -1, resetsAt: "" },
      };
    }

    const key = `ai-match:ratelimit:${userType}:${identifier}`;
    const now = new Date();
    const endOfDay = new Date(now);
    endOfDay.setUTCHours(23, 59, 59, 999);
    const ttlSeconds = Math.floor((endOfDay.getTime() - now.getTime()) / 1000);

    // Get current count
    const current = await this.redis.get(key);
    const count = current ? parseInt(current, 10) : 0;

    if (count >= limit.maxRequests) {
      return {
        allowed: false,
        info: {
          remaining: 0,
          limit: limit.maxRequests,
          resetsAt: endOfDay.toISOString(),
        },
      };
    }

    // Increment counter
    await this.redis.multi().incr(key).expire(key, ttlSeconds).exec();

    return {
      allowed: true,
      info: {
        remaining: limit.maxRequests - count - 1,
        limit: limit.maxRequests,
        resetsAt: endOfDay.toISOString(),
      },
    };
  }

  async getRateLimitInfo(
    identifier: string,
    userType: UserType
  ): Promise<RateLimitInfo> {
    const limit = this.LIMITS[userType];

    if (limit.maxRequests === -1) {
      return { remaining: -1, limit: -1, resetsAt: "" };
    }

    const key = `ai-match:ratelimit:${userType}:${identifier}`;
    const current = await this.redis.get(key);
    const count = current ? parseInt(current, 10) : 0;

    const endOfDay = new Date();
    endOfDay.setUTCHours(23, 59, 59, 999);

    return {
      remaining: Math.max(0, limit.maxRequests - count),
      limit: limit.maxRequests,
      resetsAt: endOfDay.toISOString(),
    };
  }

  getMaxResults(userType: UserType): number {
    return this.LIMITS[userType].maxResults;
  }
}
```

**File:** `api/apps/api/src/ai-match/rate-limit/rate-limit.types.ts`

```typescript
export type UserType = "guest" | "authenticated" | "recruiter";

export interface RateLimitInfo {
  remaining: number; // -1 for unlimited
  limit: number; // -1 for unlimited
  resetsAt: string; // ISO timestamp, empty for unlimited
}
```

### 11. AI Match Resolver (with Subscriptions)

**File:** `api/apps/api/src/ai-match/ai-match.resolver.ts`

```typescript
import {
  Resolver,
  Mutation,
  Query,
  Subscription,
  Args,
  Context,
} from "@nestjs/graphql";
import { ForbiddenException } from "@nestjs/common";
import { AIMatchService } from "./ai-match.service";
import { RateLimitService } from "./rate-limit/rate-limit.service";
import { SessionService } from "./session/session.service";
import { MessageQueueService } from "./queue/message-queue.service";
import { PubSubService } from "./streaming/pubsub.service";
import {
  AIMatchSendInput,
  AIMatchCancelInput,
} from "./inputs/ai-match.input";
import {
  AIMatchEvent,
  AIMatchRateLimitInfo,
  AIMatchQueueStatus,
  AIMatchSession,
} from "./models/ai-match.model";
import { ActiveUser } from "../shared/decorators/active-user.decorator";
import { User } from "../user/user.entity";
import { UserType } from "./rate-limit/rate-limit.types";

@Resolver()
export class AIMatchResolver {
  constructor(
    private aiMatchService: AIMatchService,
    private rateLimitService: RateLimitService,
    private sessionService: SessionService,
    private messageQueueService: MessageQueueService,
    private pubsubService: PubSubService
  ) {}

  // ==================== MUTATIONS ====================

  @Mutation(() => AIMatchSession)
  async aiMatchStartSession(
    @ActiveUser() user: User | null,
    @Context() ctx: any
  ): Promise<AIMatchSession> {
    const { userType } = this.getUserInfo(user, ctx);
    const userId = user?.id || null;

    const session = await this.sessionService.getOrCreateSession(null, userId);

    return {
      sessionId: session.sessionId,
      userType,
      maxResults: this.rateLimitService.getMaxResults(userType),
    };
  }

  @Mutation(() => Boolean)
  async aiMatchSendMessage(
    @Args("input") input: AIMatchSendInput,
    @ActiveUser() user: User | null,
    @Context() ctx: any
  ): Promise<boolean> {
    const { userType, identifier } = this.getUserInfo(user, ctx);

    // Check rate limit
    const { allowed, info } = await this.rateLimitService.checkAndIncrement(
      identifier,
      userType
    );

    if (!allowed) {
      throw new ForbiddenException(
        `Rate limit exceeded. You have used all ${info.limit} searches for today. ` +
          `Limit resets at ${info.resetsAt}.`
      );
    }

    // Guests can't use threads (conversation continuity)
    if (userType === "guest") {
      await this.sessionService.setThreadId(input.sessionId, null);
    }

    // Enqueue the message
    await this.messageQueueService.enqueueMessage(
      input.sessionId,
      input.prompt
    );

    // Trigger processing (async - returns immediately)
    this.aiMatchService.processQueue(input.sessionId).catch((err) => {
      console.error("Queue processing error:", err);
    });

    return true;
  }

  @Mutation(() => Boolean)
  async aiMatchCancel(
    @Args("input") input: AIMatchCancelInput
  ): Promise<boolean> {
    switch (input.target) {
      case "current":
        return this.aiMatchService.cancelCurrentRun(input.sessionId);
      case "queued":
        if (!input.messageId) {
          throw new Error("messageId required for cancelling queued message");
        }
        return this.messageQueueService.cancelMessage(
          input.sessionId,
          input.messageId
        );
      case "all":
        await this.aiMatchService.cancelCurrentRun(input.sessionId);
        const status = await this.messageQueueService.getQueueStatus(
          input.sessionId
        );
        for (const msg of status.queued) {
          await this.messageQueueService.cancelMessage(
            input.sessionId,
            msg.messageId
          );
        }
        return true;
      default:
        return false;
    }
  }

  // ==================== QUERIES ====================

  @Query(() => AIMatchRateLimitInfo)
  async aiMatchRateLimitInfo(
    @ActiveUser() user: User | null,
    @Context() ctx: any
  ): Promise<AIMatchRateLimitInfo> {
    const { userType, identifier } = this.getUserInfo(user, ctx);
    return this.rateLimitService.getRateLimitInfo(identifier, userType);
  }

  @Query(() => AIMatchQueueStatus)
  async aiMatchQueueStatus(
    @Args("sessionId") sessionId: string
  ): Promise<AIMatchQueueStatus> {
    return this.messageQueueService.getQueueStatus(sessionId);
  }

  // ==================== SUBSCRIPTIONS ====================

  @Subscription(() => AIMatchEvent, {
    filter: (payload, variables) => {
      return payload.sessionId === variables.sessionId;
    },
  })
  aiMatchEvents(@Args("sessionId") sessionId: string) {
    return this.pubsubService.subscribe(sessionId);
  }

  // ==================== HELPERS ====================

  private getUserInfo(
    user: User | null,
    ctx: any
  ): { userType: UserType; identifier: string } {
    if (!user) {
      const ip =
        ctx.req?.ip || ctx.req?.headers?.["x-forwarded-for"] || "unknown";
      const fingerprint = ctx.req?.headers?.["x-fingerprint"] || "";
      return {
        userType: "guest",
        identifier: `${ip}:${fingerprint}`,
      };
    }

    const isPaidRecruiter = user.role === "Recruiter";
    return {
      userType: isPaidRecruiter ? "recruiter" : "authenticated",
      identifier: user.id,
    };
  }
}
```

### 12. Register Module

**File:** `api/apps/api/src/ai-match/ai-match.module.ts`

```typescript
import { Module } from "@nestjs/common";
import { HttpModule } from "@nestjs/axios";
import { ConfigModule } from "@nestjs/config";
import { AIMatchService } from "./ai-match.service";
import { AIMatchResolver } from "./ai-match.resolver";
import { AIAgentClient } from "./http/ai-agent.client";
import { RateLimitService } from "./rate-limit/rate-limit.service";
import { PubSubService } from "./streaming/pubsub.service";
import { SessionService } from "./session/session.service";
import { MessageQueueService } from "./queue/message-queue.service";

@Module({
  imports: [
    HttpModule.register({
      timeout: 30000,
      maxRedirects: 3,
    }),
    ConfigModule,
  ],
  providers: [
    AIMatchService,
    AIMatchResolver,
    AIAgentClient,
    RateLimitService,
    PubSubService,
    SessionService,
    MessageQueueService,
  ],
  exports: [AIMatchService],
})
export class AIMatchModule {}
```

**Update:** `api/apps/api/src/app.module.ts`

```typescript
import { AIMatchModule } from "./ai-match/ai-match.module";

@Module({
  imports: [
    // ... existing imports
    AIMatchModule,
  ],
})
export class AppModule {}
```

---

## Frontend Changes

### 0. Apollo Client WebSocket Configuration

For GraphQL subscriptions to work, Apollo Client needs a split link setup with WebSocket support.

**File:** `frontend/src/lib/apollo/client.ts`

```typescript
import { ApolloClient, InMemoryCache, split, HttpLink } from "@apollo/client";
import { GraphQLWsLink } from "@apollo/client/link/subscriptions";
import { createClient } from "graphql-ws";
import { getMainDefinition } from "@apollo/client/utilities";

const httpLink = new HttpLink({
  uri: process.env.NEXT_PUBLIC_API_URL + "/graphql",
  credentials: "include",
});

// WebSocket link for subscriptions
const wsLink =
  typeof window !== "undefined"
    ? new GraphQLWsLink(
        createClient({
          url: process.env.NEXT_PUBLIC_WS_URL || "ws://localhost:4000/graphql",
          connectionParams: () => {
            // Include auth token if available
            const token = localStorage.getItem("token");
            return token ? { authorization: `Bearer ${token}` } : {};
          },
          // Auto-reconnect on connection loss
          retryAttempts: 5,
          shouldRetry: () => true,
          on: {
            connected: () => console.log("WebSocket connected"),
            closed: () => console.log("WebSocket closed"),
            error: (err) => console.error("WebSocket error:", err),
          },
        })
      )
    : null;

// Split traffic between HTTP and WebSocket
const splitLink =
  typeof window !== "undefined" && wsLink
    ? split(
        ({ query }) => {
          const definition = getMainDefinition(query);
          return (
            definition.kind === "OperationDefinition" &&
            definition.operation === "subscription"
          );
        },
        wsLink,
        httpLink
      )
    : httpLink;

export const apolloClient = new ApolloClient({
  link: splitLink,
  cache: new InMemoryCache(),
});
```

**Install Dependencies:**

```bash
cd frontend
npm install graphql-ws @apollo/client
```

**Environment Variables (frontend/.env.local):**

```env
NEXT_PUBLIC_API_URL=http://localhost:4000
NEXT_PUBLIC_WS_URL=ws://localhost:4000/graphql
```

### 1. GraphQL Operations

**File:** `frontend/src/lib/graphql/operations.ts`

Add new mutation:

```typescript
// Start a new session
export const AI_MATCH_START_SESSION = gql`
  mutation AIMatchStartSession {
    aiMatchStartSession {
      sessionId
      userType
      maxResults
    }
  }
`;

// Send a message (queued)
export const AI_MATCH_SEND_MESSAGE = gql`
  mutation AIMatchSendMessage($input: AIMatchSendInput!) {
    aiMatchSendMessage(input: $input)
  }
`;

// Cancel request(s)
export const AI_MATCH_CANCEL = gql`
  mutation AIMatchCancel($input: AIMatchCancelInput!) {
    aiMatchCancel(input: $input)
  }
`;

// Subscribe to events
export const AI_MATCH_EVENTS = gql`
  subscription AIMatchEvents($sessionId: String!) {
    aiMatchEvents(sessionId: $sessionId) {
      type
      sessionId
      messageId
      timestamp
      data {
        message
        toolName
        resultSummary
        candidateCount
        match {
          developer {
            id
            firstName
            lastName
            jobTitle
            bio
            techStack
            seniorityLevel
            location
            availabilityStatus
            profilePhoto {
              url
            }
          }
          matchScore
          matchReason
        }
        summary
        totalMatches
        totalCandidates
        position
        errorMessage
        isOffTopic
      }
    }
  }
`;

// Get rate limit info
export const AI_MATCH_RATE_LIMIT_INFO = gql`
  query AIMatchRateLimitInfo {
    aiMatchRateLimitInfo {
      remaining
      limit
      resetsAt
    }
  }
`;

// Get queue status
export const AI_MATCH_QUEUE_STATUS = gql`
  query AIMatchQueueStatus($sessionId: String!) {
    aiMatchQueueStatus(sessionId: $sessionId) {
      processing {
        messageId
        prompt
        status
        queuedAt
      }
      queued {
        messageId
        prompt
        status
        queuedAt
      }
    }
  }
`;
```

### 2. Run Code Generation

```bash
cd frontend
npm run codegen
```

This generates TypeScript types in `frontend/src/lib/graphql/generated.ts`.

### 3. Update AIMatchPage Component (Chat UI with Subscriptions)

**File:** `frontend/src/app/dashboard/ai-match/page.tsx`

```tsx
"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import {
  useAiMatchStartSessionMutation,
  useAiMatchSendMessageMutation,
  useAiMatchCancelMutation,
  useAiMatchEventsSubscription,
  useAiMatchRateLimitInfoQuery,
  AiMatchEventType,
} from "@/lib/graphql/generated";
import { useUser } from "@/hooks/useUser";
import {
  SparklesIcon,
  PaperAirplaneIcon,
  StopIcon,
} from "@heroicons/react/24/outline";
import ChatMessage from "./components/ChatMessage";
import MatchResultCard from "./components/MatchResultCard";
import ThinkingIndicator from "./components/ThinkingIndicator";
import QueueIndicator from "./components/QueueIndicator";
import ConnectionStatusIndicator from "./components/ConnectionStatusIndicator";
import RateLimitBanner from "./components/RateLimitBanner";
import SignUpPrompt from "./components/SignUpPrompt";

interface ChatItem {
  id: string;
  type: "user" | "assistant" | "thinking" | "tool" | "match" | "error";
  content: string;
  timestamp: string;
  data?: any;
}

const EXAMPLE_PROMPTS = [
  "Senior Next.js + NestJS developer for SaaS",
  "React Native + Firebase mobile developer",
  "Backend engineer with distributed systems experience",
  "Vue.js + GraphQL frontend lead",
];

export default function AIMatchPage() {
  const router = useRouter();
  const { isAuthenticated, isGuest } = useUser();

  const [sessionId, setSessionId] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [chatHistory, setChatHistory] = useState<ChatItem[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isSending, setIsSending] = useState(false); // Debounce protection
  const [queuedCount, setQueuedCount] = useState(0);
  const [showSignUpPrompt, setShowSignUpPrompt] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<"connected" | "reconnecting" | "disconnected">("connected");

  const chatEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const sendTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Mutations
  const [startSession] = useAiMatchStartSessionMutation();
  const [sendMessage] = useAiMatchSendMessageMutation();
  const [cancelMatch] = useAiMatchCancelMutation();

  // Queries
  const { data: rateLimitData, refetch: refetchRateLimit } =
    useAiMatchRateLimitInfoQuery();

  // Subscription - only active when we have a session
  const { data: eventData, error: subscriptionError } = useAiMatchEventsSubscription({
    variables: { sessionId: sessionId! },
    skip: !sessionId,
    onSubscriptionData: () => setConnectionStatus("connected"),
  });

  // Track WebSocket connection status
  useEffect(() => {
    if (subscriptionError) {
      setConnectionStatus("reconnecting");
    }
  }, [subscriptionError]);

  // Initialize session on mount
  useEffect(() => {
    const initSession = async () => {
      try {
        const { data } = await startSession();
        if (data?.aiMatchStartSession?.sessionId) {
          setSessionId(data.aiMatchStartSession.sessionId);
        }
      } catch (err) {
        console.error("Failed to start session:", err);
      }
    };
    initSession();
  }, [startSession]);

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (sendTimeoutRef.current) {
        clearTimeout(sendTimeoutRef.current);
      }
    };
  }, []);

  // Handle subscription events
  useEffect(() => {
    if (!eventData?.aiMatchEvents) return;

    const event = eventData.aiMatchEvents;

    switch (event.type) {
      case "MESSAGE_QUEUED":
        setQueuedCount((prev) => prev + 1);
        break;

      case "MESSAGE_STARTED":
        setIsProcessing(true);
        setQueuedCount((prev) => Math.max(0, prev - 1));
        break;

      case "THINKING":
        setChatHistory((prev) => {
          // Update or add thinking message
          const existing = prev.find(
            (item) => item.type === "thinking" && item.id === event.messageId
          );
          if (existing) {
            return prev.map((item) =>
              item.id === event.messageId
                ? { ...item, content: event.data?.message || "Thinking..." }
                : item
            );
          }
          return [
            ...prev,
            {
              id: event.messageId,
              type: "thinking",
              content: event.data?.message || "Thinking...",
              timestamp: event.timestamp,
            },
          ];
        });
        break;

      case "TOOL_CALL":
        setChatHistory((prev) => [
          ...prev.filter((item) => item.type !== "thinking"),
          {
            id: `${event.messageId}-tool-${Date.now()}`,
            type: "tool",
            content: `Searching: ${event.data?.toolName}`,
            timestamp: event.timestamp,
            data: event.data,
          },
        ]);
        break;

      case "TOOL_RESULT":
        setChatHistory((prev) =>
          prev.map((item) =>
            item.type === "tool" && item.content.includes(event.data?.toolName)
              ? {
                  ...item,
                  content: event.data?.resultSummary || item.content,
                }
              : item
          )
        );
        break;

      case "MATCH_FOUND":
        setChatHistory((prev) => [
          ...prev.filter((item) => item.type !== "thinking"),
          {
            id: `match-${event.data?.match?.developer?.id}`,
            type: "match",
            content: "",
            timestamp: event.timestamp,
            data: event.data?.match,
          },
        ]);
        break;

      case "COMPLETE":
        setIsProcessing(false);
        setChatHistory((prev) => [
          ...prev.filter((item) => item.type !== "thinking"),
          {
            id: `complete-${event.messageId}`,
            type: "assistant",
            content: event.data?.summary || "Search complete.",
            timestamp: event.timestamp,
            data: {
              totalMatches: event.data?.totalMatches,
              totalCandidates: event.data?.totalCandidates,
              isOffTopic: event.data?.isOffTopic,
            },
          },
        ]);
        refetchRateLimit();
        if (isGuest && event.data?.totalMatches > 0) {
          setShowSignUpPrompt(true);
        }
        break;

      case "ERROR":
        setIsProcessing(false);
        setChatHistory((prev) => [
          ...prev.filter((item) => item.type !== "thinking"),
          {
            id: `error-${event.messageId}`,
            type: "error",
            content: event.data?.errorMessage || "An error occurred.",
            timestamp: event.timestamp,
          },
        ]);
        break;

      case "CANCELLED":
        setIsProcessing(false);
        setChatHistory((prev) => prev.filter((item) => item.type !== "thinking"));
        break;
    }
  }, [eventData, isGuest, refetchRateLimit]);

  // Auto-scroll to bottom
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chatHistory]);

  const handleSubmit = async () => {
    // Debounce: prevent rapid double-clicks
    if (!prompt.trim() || !sessionId || isSending) return;

    // Clear any pending timeout
    if (sendTimeoutRef.current) {
      clearTimeout(sendTimeoutRef.current);
    }

    setIsSending(true);

    const userMessage: ChatItem = {
      id: `user-${Date.now()}`,
      type: "user",
      content: prompt.trim(),
      timestamp: new Date().toISOString(),
    };

    setChatHistory((prev) => [...prev, userMessage]);
    setPrompt("");

    try {
      await sendMessage({
        variables: {
          input: {
            sessionId,
            prompt: userMessage.content,
          },
        },
      });
    } catch (err: any) {
      setChatHistory((prev) => [
        ...prev,
        {
          id: `error-${Date.now()}`,
          type: "error",
          content: err.message || "Failed to send message",
          timestamp: new Date().toISOString(),
        },
      ]);
    } finally {
      // Re-enable after short delay to prevent accidental double-sends
      sendTimeoutRef.current = setTimeout(() => {
        setIsSending(false);
      }, 500);
    }
  };

  const handleCancel = async () => {
    if (!sessionId) return;
    try {
      await cancelMatch({
        variables: {
          input: {
            sessionId,
            target: "current",
          },
        },
      });
    } catch (err) {
      console.error("Failed to cancel:", err);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const handleExampleClick = (example: string) => {
    setPrompt(example);
    textareaRef.current?.focus();
  };

  const handleNewConversation = async () => {
    setChatHistory([]);
    setShowSignUpPrompt(false);
    // Start fresh session
    try {
      const { data } = await startSession();
      if (data?.aiMatchStartSession?.sessionId) {
        setSessionId(data.aiMatchStartSession.sessionId);
      }
    } catch (err) {
      console.error("Failed to start new session:", err);
    }
  };

  const rateLimit = rateLimitData?.aiMatchRateLimitInfo;
  const isRateLimitExceeded = rateLimit?.remaining === 0;

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="border-b border-gray-200 p-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-violet-100 rounded-lg">
              <SparklesIcon className="w-6 h-6 text-violet-600" />
            </div>
            <div>
              <h1 className="text-xl font-semibold">AI Matching Assistant</h1>
              <p className="text-sm text-gray-500">
                Describe your ideal developer and refine your search
              </p>
            </div>
          </div>

          <div className="flex items-center gap-4">
            {/* Connection Status */}
            {connectionStatus !== "connected" && (
              <ConnectionStatusIndicator status={connectionStatus} />
            )}

            {/* Queue Indicator */}
            {queuedCount > 0 && <QueueIndicator count={queuedCount} />}

            {/* Rate Limit Info */}
            {rateLimit && rateLimit.limit > 0 && (
              <div className="text-sm text-gray-500">
                {rateLimit.remaining} / {rateLimit.limit} searches today
              </div>
            )}

            {/* New Conversation */}
            {chatHistory.length > 0 && (
              <button
                onClick={handleNewConversation}
                className="text-sm text-violet-600 hover:text-violet-700"
              >
                New Conversation
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Rate Limit Banner */}
      {isGuest && rateLimit && (
        <RateLimitBanner
          remaining={rateLimit.remaining}
          limit={rateLimit.limit}
          resetsAt={rateLimit.resetsAt}
        />
      )}

      {/* Chat Area */}
      <div className="flex-1 overflow-y-auto p-6">
        {/* Empty State */}
        {chatHistory.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-center">
            <SparklesIcon className="w-12 h-12 text-gray-300 mb-4" />
            <h2 className="text-lg font-medium text-gray-900 mb-2">
              Find Your Perfect Developer Match
            </h2>
            <p className="text-gray-500 mb-6 max-w-md">
              Describe the skills, experience, and qualities you're looking for.
              You can refine your search with follow-up messages.
            </p>

            <div className="flex flex-wrap gap-2 justify-center">
              {EXAMPLE_PROMPTS.map((example) => (
                <button
                  key={example}
                  onClick={() => handleExampleClick(example)}
                  className="px-4 py-2 bg-gray-100 hover:bg-gray-200 rounded-full text-sm text-gray-700 transition-colors"
                >
                  {example}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Chat Messages */}
        {chatHistory.map((item) => (
          <ChatMessage key={item.id} item={item} isGuest={isGuest} />
        ))}

        {/* Processing Indicator */}
        {isProcessing && <ThinkingIndicator />}

        {/* Sign Up Prompt */}
        {showSignUpPrompt && isGuest && (
          <SignUpPrompt onDismiss={() => setShowSignUpPrompt(false)} />
        )}

        <div ref={chatEndRef} />
      </div>

      {/* Input Area */}
      <div className="border-t border-gray-200 p-4">
        {isRateLimitExceeded ? (
          <div className="text-center py-4">
            <p className="text-amber-600">
              Daily limit reached.{" "}
              {isGuest ? (
                <button
                  onClick={() => router.push("/join")}
                  className="text-violet-600 hover:underline"
                >
                  Sign up for more searches
                </button>
              ) : (
                `Resets at ${new Date(rateLimit?.resetsAt || "").toLocaleTimeString()}`
              )}
            </p>
          </div>
        ) : (
          <>
            <div className="flex gap-3">
              <textarea
                ref={textareaRef}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={
                  chatHistory.length > 0
                    ? "Refine your search or ask a follow-up..."
                    : "Describe the developer you're looking for..."
                }
                rows={2}
                disabled={isProcessing}
                className="flex-1 resize-none border border-gray-300 rounded-lg px-4 py-3 focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent disabled:bg-gray-50"
              />
              {isProcessing ? (
                <button
                  onClick={handleCancel}
                  className="px-6 bg-red-500 text-white rounded-lg hover:bg-red-600 flex items-center gap-2"
                >
                  <StopIcon className="w-5 h-5" />
                  Stop
                </button>
              ) : (
                <button
                  onClick={handleSubmit}
                  disabled={!prompt.trim() || !sessionId}
                  className="px-6 bg-violet-600 text-white rounded-lg hover:bg-violet-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
                >
                  <PaperAirplaneIcon className="w-5 h-5" />
                  Send
                </button>
              )}
            </div>
            <p className="text-xs text-gray-400 mt-2">
              Press Enter to send, Shift+Enter for new line
              {chatHistory.length > 0 && " • Messages are queued and processed in order"}
            </p>
          </>
        )}
      </div>
    </div>
  );
}
```

### 4. New Components

**File:** `frontend/src/app/dashboard/ai-match/components/ChatMessage.tsx`

```tsx
import { SparklesIcon, UserIcon, WrenchIcon } from "@heroicons/react/24/outline";
import MatchResultCard from "./MatchResultCard";

interface ChatItem {
  id: string;
  type: "user" | "assistant" | "thinking" | "tool" | "match" | "error";
  content: string;
  timestamp: string;
  data?: any;
}

interface ChatMessageProps {
  item: ChatItem;
  isGuest: boolean;
}

export default function ChatMessage({ item, isGuest }: ChatMessageProps) {
  switch (item.type) {
    case "user":
      return (
        <div className="flex gap-3 mb-4 justify-end">
          <div className="bg-violet-600 text-white rounded-lg px-4 py-3 max-w-[80%]">
            <p>{item.content}</p>
          </div>
          <div className="w-8 h-8 bg-gray-200 rounded-full flex items-center justify-center shrink-0">
            <UserIcon className="w-5 h-5 text-gray-600" />
          </div>
        </div>
      );

    case "assistant":
      return (
        <div className="flex gap-3 mb-4">
          <div className="w-8 h-8 bg-violet-100 rounded-full flex items-center justify-center shrink-0">
            <SparklesIcon className="w-5 h-5 text-violet-600" />
          </div>
          <div className="bg-gray-100 rounded-lg px-4 py-3 max-w-[80%]">
            <p className="text-gray-800">{item.content}</p>
            {item.data?.totalMatches !== undefined && (
              <p className="text-sm text-gray-500 mt-2">
                Found {item.data.totalMatches} matches from {item.data.totalCandidates} candidates
              </p>
            )}
          </div>
        </div>
      );

    case "tool":
      return (
        <div className="flex gap-3 mb-2 ml-11">
          <div className="flex items-center gap-2 text-sm text-gray-500">
            <WrenchIcon className="w-4 h-4" />
            <span>{item.content}</span>
          </div>
        </div>
      );

    case "match":
      return (
        <div className="mb-4 ml-11">
          <MatchResultCard
            developer={item.data.developer}
            matchScore={item.data.matchScore}
            matchReason={item.data.matchReason}
            onDismiss={() => {}}
            isGuest={isGuest}
          />
        </div>
      );

    case "error":
      return (
        <div className="flex gap-3 mb-4">
          <div className="w-8 h-8 bg-red-100 rounded-full flex items-center justify-center shrink-0">
            <SparklesIcon className="w-5 h-5 text-red-600" />
          </div>
          <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 max-w-[80%]">
            <p className="text-red-700">{item.content}</p>
          </div>
        </div>
      );

    case "thinking":
      return null; // Handled by ThinkingIndicator

    default:
      return null;
  }
}
```

**File:** `frontend/src/app/dashboard/ai-match/components/ThinkingIndicator.tsx`

```tsx
import { SparklesIcon } from "@heroicons/react/24/outline";

export default function ThinkingIndicator() {
  return (
    <div className="flex gap-3 mb-4">
      <div className="w-8 h-8 bg-violet-100 rounded-full flex items-center justify-center shrink-0">
        <SparklesIcon className="w-5 h-5 text-violet-600 animate-pulse" />
      </div>
      <div className="bg-gray-100 rounded-lg px-4 py-3">
        <div className="flex items-center gap-2">
          <div className="flex gap-1">
            <span className="w-2 h-2 bg-violet-400 rounded-full animate-bounce" style={{ animationDelay: "0ms" }} />
            <span className="w-2 h-2 bg-violet-400 rounded-full animate-bounce" style={{ animationDelay: "150ms" }} />
            <span className="w-2 h-2 bg-violet-400 rounded-full animate-bounce" style={{ animationDelay: "300ms" }} />
          </div>
          <span className="text-sm text-gray-500">Analyzing...</span>
        </div>
      </div>
    </div>
  );
}
```

**File:** `frontend/src/app/dashboard/ai-match/components/QueueIndicator.tsx`

```tsx
interface QueueIndicatorProps {
  count: number;
}

export default function QueueIndicator({ count }: QueueIndicatorProps) {
  return (
    <div className="flex items-center gap-2 text-sm text-amber-600 bg-amber-50 px-3 py-1 rounded-full">
      <span className="w-2 h-2 bg-amber-500 rounded-full animate-pulse" />
      <span>{count} message{count !== 1 ? "s" : ""} queued</span>
    </div>
  );
}
```

**File:** `frontend/src/app/dashboard/ai-match/components/ConnectionStatusIndicator.tsx`

```tsx
import { WifiIcon, ExclamationTriangleIcon } from "@heroicons/react/24/outline";

interface ConnectionStatusIndicatorProps {
  status: "connected" | "reconnecting" | "disconnected";
}

export default function ConnectionStatusIndicator({
  status,
}: ConnectionStatusIndicatorProps) {
  if (status === "connected") return null;

  const config = {
    reconnecting: {
      icon: WifiIcon,
      text: "Reconnecting...",
      className: "text-amber-600 bg-amber-50",
      iconClassName: "animate-pulse",
    },
    disconnected: {
      icon: ExclamationTriangleIcon,
      text: "Disconnected",
      className: "text-red-600 bg-red-50",
      iconClassName: "",
    },
  };

  const { icon: Icon, text, className, iconClassName } = config[status];

  return (
    <div className={`flex items-center gap-2 text-sm px-3 py-1 rounded-full ${className}`}>
      <Icon className={`w-4 h-4 ${iconClassName}`} />
      <span>{text}</span>
    </div>
  );
}
```

**File:** `frontend/src/app/dashboard/ai-match/components/MatchResultCard.tsx`

```tsx
import Link from "next/link";
import Image from "next/image";
import { XMarkIcon, StarIcon } from "@heroicons/react/24/outline";
import { Developer } from "@/lib/graphql/generated";

interface MatchResultCardProps {
  developer: Developer;
  matchScore: number;
  matchReason: string;
  onDismiss: () => void;
  isGuest?: boolean;
}

export default function MatchResultCard({
  developer,
  matchScore,
  matchReason,
  onDismiss,
  isGuest = false,
}: MatchResultCardProps) {
  const scoreColor =
    matchScore >= 80
      ? "text-green-600 bg-green-50"
      : matchScore >= 60
        ? "text-yellow-600 bg-yellow-50"
        : "text-gray-600 bg-gray-50";

  return (
    <div className="border border-gray-200 rounded-lg p-4 hover:shadow-md transition-shadow">
      <div className="flex items-start gap-4">
        {/* Profile Photo */}
        <div className="w-16 h-16 rounded-full overflow-hidden bg-gray-100 shrink-0">
          {developer.profilePhoto?.url ? (
            <Image
              src={developer.profilePhoto.url}
              alt={developer.firstName}
              width={64}
              height={64}
              className="object-cover"
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-gray-400 text-xl font-medium">
              {developer.firstName?.[0]}
              {developer.lastName?.[0]}
            </div>
          )}
        </div>

        {/* Info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between">
            <Link
              href={`/dashboard/developers/${developer.id}`}
              className="font-medium text-gray-900 hover:text-violet-600"
            >
              {developer.firstName} {developer.lastName}
            </Link>
            <div className={`px-2 py-1 rounded-full text-sm font-medium ${scoreColor}`}>
              {matchScore}% match
            </div>
          </div>

          <p className="text-sm text-gray-500">
            {developer.jobTitle} • {developer.seniorityLevel} • {developer.location}
          </p>

          {/* Tech Stack */}
          <div className="flex flex-wrap gap-1 mt-2">
            {developer.techStack?.slice(0, 5).map((tech) => (
              <span
                key={tech}
                className="px-2 py-0.5 bg-gray-100 text-gray-600 text-xs rounded"
              >
                {tech}
              </span>
            ))}
            {developer.techStack?.length > 5 && (
              <span className="px-2 py-0.5 text-gray-400 text-xs">
                +{developer.techStack.length - 5} more
              </span>
            )}
          </div>

          {/* Match Reason */}
          <p className="text-sm text-gray-600 mt-3 italic">"{matchReason}"</p>
        </div>

        {/* Actions */}
        <div className="flex flex-col gap-2">
          <button
            onClick={onDismiss}
            className="p-2 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-full"
            title="Dismiss"
          >
            <XMarkIcon className="w-5 h-5" />
          </button>
        </div>
      </div>
    </div>
  );
}
```

**File:** `frontend/src/app/dashboard/ai-match/components/LoadingState.tsx`

```tsx
import { SparklesIcon } from "@heroicons/react/24/outline";

export default function LoadingState() {
  return (
    <div className="flex flex-col items-center justify-center h-64">
      <div className="relative">
        <SparklesIcon className="w-12 h-12 text-violet-500 animate-pulse" />
        <div className="absolute -inset-2 bg-violet-100 rounded-full animate-ping opacity-25" />
      </div>
      <p className="mt-4 text-gray-600 font-medium">Analyzing developers...</p>
      <p className="text-sm text-gray-400">This may take a few moments</p>
    </div>
  );
}
```

**File:** `frontend/src/app/dashboard/ai-match/components/RateLimitBanner.tsx`

```tsx
interface RateLimitBannerProps {
  remaining: number;
  limit: number;
  resetsAt: string;
}

export default function RateLimitBanner({
  remaining,
  limit,
  resetsAt,
}: RateLimitBannerProps) {
  if (remaining > 1) return null;

  const isExhausted = remaining === 0;

  return (
    <div
      className={`px-6 py-3 text-sm ${
        isExhausted
          ? "bg-amber-100 text-amber-800"
          : "bg-blue-50 text-blue-700"
      }`}
    >
      {isExhausted ? (
        <span>
          You've used all {limit} free searches today. Sign up for more!
        </span>
      ) : (
        <span>
          {remaining} free search{remaining !== 1 ? "es" : ""} remaining.
          Sign up for unlimited searches.
        </span>
      )}
    </div>
  );
}
```

**File:** `frontend/src/app/dashboard/ai-match/components/SignUpPrompt.tsx`

```tsx
import Link from "next/link";
import { XMarkIcon } from "@heroicons/react/24/outline";

interface SignUpPromptProps {
  onDismiss: () => void;
}

export default function SignUpPrompt({ onDismiss }: SignUpPromptProps) {
  return (
    <div className="bg-linear-to-r from-violet-500 to-purple-600 rounded-lg p-6 text-white relative">
      <button
        onClick={onDismiss}
        className="absolute top-3 right-3 p-1 hover:bg-white/20 rounded"
      >
        <XMarkIcon className="w-5 h-5" />
      </button>

      <h3 className="text-lg font-semibold">Like what you see?</h3>
      <p className="mt-2 text-violet-100">
        Create a free account to save developers to your shortlist,
        get more daily searches, and continue conversations with AI.
      </p>

      <div className="flex gap-3 mt-4">
        <Link
          href="/join"
          className="px-4 py-2 bg-white text-violet-600 rounded-lg font-medium hover:bg-violet-50"
        >
          Sign Up Free
        </Link>
        <Link
          href="/signin"
          className="px-4 py-2 border border-white/50 rounded-lg hover:bg-white/10"
        >
          Sign In
        </Link>
      </div>
    </div>
  );
}
```

---

## Environment Variables

### Main API Service (`api/apps/api/.env`)

```env
# Database
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/devmatch

# Redis
REDIS_HOST=localhost
REDIS_PORT=6379

# HTTP - AI Agent Service
AI_AGENT_URL=http://localhost:4001

# JWT (existing)
JWT_SECRET=your-jwt-secret
```

### AI Agent Service (`api/apps/ai-agent/.env`)

```env
# Database (read-only access for developer search)
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/devmatch

# Redis (for publishing events)
REDIS_HOST=localhost
REDIS_PORT=6379

# OpenAI
OPENAI_API_KEY=sk-...
OPENAI_ASSISTANT_ID=asst_...  # Optional: created on first run if not set
```

### Cron Service (`api/apps/cron/.env`)

```env
# Database
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/devmatch

# Redis
REDIS_HOST=localhost
REDIS_PORT=6379

# OpenAI (for thread cleanup)
OPENAI_API_KEY=sk-...
```

### Docker Environment (`.env` in api root)

```env
# Shared secrets for docker-compose
OPENAI_API_KEY=sk-...
OPENAI_ASSISTANT_ID=asst_...
POSTGRES_PASSWORD=postgres
```

### NPM Dependencies

Install dependencies for all services:

```bash
cd api

# Core dependencies
npm install openai @nestjs/axios axios

# Scheduling for cron service
npm install @nestjs/schedule

# Redis and GraphQL subscriptions
npm install ioredis graphql-redis-subscriptions graphql-subscriptions
```

---

## Running the Services

### Development (Individual Services)

```bash
# Terminal 1: Main API
cd api
npm run start:dev api

# Terminal 2: AI Agent Service
cd api
npm run start:dev ai-agent

# Terminal 3: Cron Service
cd api
npm run start:dev cron

# Terminal 4: Redis (if not using Docker)
redis-server

# Terminal 5: PostgreSQL (if not using Docker)
# Use your local PostgreSQL
```

### Development (Docker Compose)

```bash
cd api

# Start all services
docker-compose up

# Start specific service
docker-compose up main-api ai-agent

# Rebuild after code changes
docker-compose up --build

# View logs
docker-compose logs -f ai-agent
```

### Build Commands

```bash
cd api

# Build individual service
npm run build api
npm run build ai-agent
npm run build cron

# Build all
npm run build
```

### Useful Scripts (add to package.json)

```json
{
  "scripts": {
    "start:dev:api": "nest start api --watch",
    "start:dev:ai-agent": "nest start ai-agent --watch",
    "start:dev:cron": "nest start cron --watch",
    "start:dev:all": "concurrently \"npm run start:dev:api\" \"npm run start:dev:ai-agent\" \"npm run start:dev:cron\"",
    "build:api": "nest build api",
    "build:ai-agent": "nest build ai-agent",
    "build:cron": "nest build cron"
  }
}
```

---

## Database Considerations

No schema changes required. The feature uses existing Developer data.

**Optional optimization:** Add a full-text search index for better initial filtering:

```sql
CREATE INDEX idx_developer_search ON developer
USING GIN (to_tsvector('english',
  COALESCE(first_name, '') || ' ' ||
  COALESCE(last_name, '') || ' ' ||
  COALESCE(job_title, '') || ' ' ||
  COALESCE(bio, '')
));
```

---

## Implementation Checklist

### Phase 1: Monorepo Setup
- [ ] Configure `nest-cli.json` for monorepo with 3 apps + shared library
- [ ] Create `api/apps/ai-agent/` directory structure
- [ ] Create `api/apps/cron/` directory structure
- [ ] Create `api/libs/shared/` for shared types
- [ ] Install dependencies (`npm install openai @nestjs/axios axios @nestjs/schedule ioredis`)
- [ ] Configure TypeScript paths for `@app/shared`

### Phase 2: AI Agent Service (Microservice)
- [ ] Create `ai-agent.module.ts`
- [ ] Create `ai-agent.controller.ts` with HTTP endpoints
- [ ] Implement `OpenAIAgentService` with streaming
- [ ] Create `ToolHandlers` for database operations
- [ ] Define `TOOL_DEFINITIONS` for function calling
- [ ] Write `ASSISTANT_INSTRUCTIONS` with scope guardrails
- [ ] Implement `EventPublisherService` (publishes to Redis)
- [ ] Add health check endpoint
- [ ] Create `main.ts` for HTTP service bootstrap
- [ ] Create Dockerfile for ai-agent service
- [ ] Add stream error handling with try/catch

### Phase 3: Cron Service (Microservice)
- [ ] Create `cron.module.ts` with ScheduleModule
- [ ] Implement `ThreadCleanupJob` (daily at 3 AM)
- [ ] Implement `SessionExpiryJob` (hourly)
- [ ] Create `OpenAICleanupService`
- [ ] Create `RedisCleanupService`
- [ ] Create `main.ts` for cron service bootstrap
- [ ] Create Dockerfile for cron service
- [ ] Track created threads in Redis for cleanup

### Phase 4: Main API Integration
- [ ] Create `AIAgentClient` (HTTP client using @nestjs/axios)
- [ ] Update `AIMatchService` to use HTTP client
- [ ] Implement `PubSubService` (Redis subscriber)
- [ ] Implement `SessionService` (session state management)
- [ ] Create `session.types.ts` with SessionState interface
- [ ] Implement `MessageQueueService` (message queuing)
- [ ] Create `queue.types.ts` with QueuedMessage interface
- [ ] Add race condition lock for queue processing
- [ ] Register AI Match module in `app.module.ts`

### Phase 5: Rate Limiting & Access Control
- [ ] Implement `RateLimitService` (Redis-based)
- [ ] Create rate limit types and constants
- [ ] Update resolver to handle guests (no auth required)
- [ ] Add fingerprint header support for guest tracking
- [ ] Implement different limits per user type (guest/user/recruiter)
- [ ] Add `aiMatchRateLimitInfo` query

### Phase 6: Frontend Integration
- [ ] Install WebSocket dependencies (`npm install graphql-ws`)
- [ ] Configure Apollo Client with split link (HTTP + WebSocket)
- [ ] Add GraphQL operations (mutations, subscription, queries)
- [ ] Create chat-based `AIMatchPage` component
- [ ] Add debounce protection on submit button
- [ ] Create `ChatMessage`, `ThinkingIndicator`, `QueueIndicator` components
- [ ] Create `ConnectionStatusIndicator`, `MatchResultCard` components
- [ ] Handle real-time events via subscription
- [ ] Handle cancel functionality
- [ ] Show rate limit info for guests

### Phase 7: Docker & Deployment
- [ ] Create `docker-compose.yml` with all services
- [ ] Create Dockerfile for ai-agent
- [ ] Create Dockerfile for cron
- [ ] Configure service networking
- [ ] Add health check endpoints to all services

### Phase 8: Polish
- [ ] Handle WebSocket reconnection with retry logic
- [ ] Add request timeout to HTTP client
- [ ] Add structured logging with correlation IDs

---

## Agent Flow Diagram

```
User sends: "Senior React developer with AWS experience"
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│                    Message Queue                             │
│  ┌─────────────────────────────────────────────────────┐    │
│  │ [Processing] "Senior React developer..."             │    │
│  │ [Queued #1]  "Also needs GraphQL experience"        │    │
│  └─────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
                            │
        Events streamed via WebSocket subscription
                            │
┌───────────────────────────┼───────────────────────────────┐
│                           ▼                                │
│  ┌─────────────────────────────────────────────────────┐  │
│  │ THINKING: "Analyzing your request..."               │  │
│  └─────────────────────────────────────────────────────┘  │
│                           │                                │
│  ┌─────────────────────────────────────────────────────┐  │
│  │ TOOL_CALL: search_developers(React, AWS, Senior)    │  │
│  └─────────────────────────────────────────────────────┘  │
│                           │                                │
│  ┌─────────────────────────────────────────────────────┐  │
│  │ TOOL_RESULT: "Found 25 candidates"                  │  │
│  └─────────────────────────────────────────────────────┘  │
│                           │                                │
│  ┌─────────────────────────────────────────────────────┐  │
│  │ MATCH_FOUND: { developer: {...}, score: 92 }        │  │
│  │ MATCH_FOUND: { developer: {...}, score: 87 }        │  │
│  │ MATCH_FOUND: { developer: {...}, score: 85 }        │  │
│  └─────────────────────────────────────────────────────┘  │
│                           │                                │
│  ┌─────────────────────────────────────────────────────┐  │
│  │ COMPLETE: { summary: "Found 3 matches...", ... }    │  │
│  └─────────────────────────────────────────────────────┘  │
│                                                            │
│  → Next queued message starts automatically                │
└────────────────────────────────────────────────────────────┘
```

---

## Future Enhancements

1. **Saved conversations** - Persist chat history for later retrieval
2. **File search** - Upload job descriptions for matching
3. **Code interpreter** - Analyze candidate GitHub repositories
4. **Vector store** - Use OpenAI's vector store for semantic search
5. **Cost tracking** - Monitor token usage per user/organization
6. **Typing indicators** - Show "Agent is typing..." with character-by-character streaming
7. **Export results** - Export matches to CSV/PDF
8. **Scheduled searches** - Run searches on a schedule and get notifications
