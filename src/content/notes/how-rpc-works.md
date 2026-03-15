---
title: How RPC Works — and When to Use gRPC
description: Personal notes on RPC mechanics, gRPC internals, real-world use cases, and when not to use it.
duration: 18 min
date: 2026-03-15
---

These are my notes on RPC after reading [How RPC Works](https://newsletter.systemdesign.one/p/how-rpc-works). I want to go beyond the mechanics and focus on the practical side — where gRPC actually makes sense, where it doesn't, and why.

## What is RPC?

RPC (Remote Procedure Call) lets you call a function on another machine as if it were local. The network complexity — sockets, serialization, protocols — is hidden behind a generated client stub.

The basic flow:

```
Client Code
  → Client Stub (serialize args)
    → Network (HTTP/2, binary payload)
      → Server Skeleton (deserialize)
        → Actual handler function
          → Response travels back the same path
```

It's not magic. The stub is just generated code that handles the boring parts so you can write:

```go
resp, err := userClient.GetUser(ctx, &pb.GetUserRequest{Id: 42})
```

...instead of manually crafting HTTP requests and parsing JSON.

## gRPC specifically

gRPC is Google's open-source RPC framework. What sets it apart:

- **Protocol Buffers** for serialization — binary format, ~3-10x smaller than JSON
- **HTTP/2** as transport — multiplexing, header compression, persistent connections
- **Code generation** — `.proto` files define the contract, `protoc` generates stubs for any language
- **Streaming built-in** — server-side, client-side, and bidirectional streaming out of the box

```proto
// Example .proto definition
service UserService {
  rpc GetUser (GetUserRequest) returns (UserResponse);
  rpc WatchUser (GetUserRequest) returns (stream UserEvent); // server streaming
}

message GetUserRequest {
  int64 id = 1;
}

message UserResponse {
  int64 id = 1;
  string name = 2;
  string email = 3;
}
```

The `.proto` file is the contract. Both client and server are generated from it — this eliminates the "our API docs are wrong" class of bugs.

## How failure handling works

Network calls fail. The question is how gracefully. gRPC gives you a set of tools — but what matters is knowing which one to reach for in a given business scenario.

### Deadlines — the call chain time budget

Every gRPC call should carry a deadline. Not a timeout on a single hop — a **deadline that propagates** through the entire call chain.

```go
// API gateway receives request, sets the total budget
ctx, cancel := context.WithTimeout(context.Background(), 800*time.Millisecond)
defer cancel()

// This deadline flows into every downstream call automatically
orderResp, err := orderClient.PlaceOrder(ctx, req)
```

If `order-service` calls `inventory-service` and `payment-service`, both inherit the remaining time from the same context. When the deadline expires, gRPC cancels in-flight calls across the whole chain — no dangling goroutines waiting on a response nobody needs anymore.

**Real scenario — e-commerce checkout**:

```
User clicks "Place Order"
  → API Gateway (800ms deadline set)
    → order-service (inherits deadline, ~780ms remaining)
      → inventory-service.Reserve()   ─┐ parallel calls
      → payment-service.Charge()      ─┘
        → fraud-detection-service.Check() (maybe 200ms remaining here)
```

If `fraud-detection-service` is slow and the deadline expires, `payment-service` gets a `DEADLINE_EXCEEDED` error and can abort — instead of waiting indefinitely and causing the API gateway to timeout separately. The user sees a clean error, not a hanging spinner.

Without deadline propagation, each service sets its own independent timeout. You end up with payment charged but inventory not reserved, because one timed out and the other didn't.

---

### Status codes — knowing what actually went wrong

gRPC has 16 standardized status codes. The key ones in practice:

| Code | Meaning | Retry? |
|---|---|---|
| `OK` | Success | — |
| `UNAVAILABLE` | Server temporarily down | Yes, safe to retry |
| `DEADLINE_EXCEEDED` | Ran out of time | Only if idempotent |
| `NOT_FOUND` | Resource doesn't exist | No |
| `ALREADY_EXISTS` | Duplicate creation attempt | No |
| `PERMISSION_DENIED` | Auth failed | No |
| `RESOURCE_EXHAUSTED` | Rate limited / quota hit | Yes, with backoff |
| `INTERNAL` | Server-side bug | No (retry won't help) |

This matters because your retry logic depends on the code. Blindly retrying all errors is dangerous.

**Real scenario — payment processing**:

The `payment-service` calls an external payment gateway via an internal `gateway-service`. The call fails. What do you do?

- `UNAVAILABLE` → gateway is down, retry with exponential backoff
- `DEADLINE_EXCEEDED` → charge might have gone through, **do not retry blindly** — check payment status first
- `ALREADY_EXISTS` → idempotency key collision, the charge already happened — return success to caller
- `INTERNAL` → something exploded in gateway-service, page someone, don't retry

Without typed status codes, you're back to parsing error strings and hoping they match.

---

### Retries + idempotency keys

Safe retries require **idempotency** — calling the same operation twice produces the same result as calling it once.

For read operations (`GetUser`, `ListOrders`), retries are always safe. For writes, you need idempotency keys.

**Real scenario — ride-sharing, driver assignment**:

```
dispatch-service calls driver-service.AssignDriver(rideId, driverId)
  → network blip → UNAVAILABLE
  → dispatch-service retries
  → driver-service receives the call again
```

Without an idempotency key, `driver-service` assigns the driver twice — creating two rides or throwing an error. With one:

```proto
message AssignDriverRequest {
  string ride_id = 1;
  string driver_id = 2;
  string idempotency_key = 3; // e.g., "ride_456_assign_attempt_1"
}
```

`driver-service` stores processed idempotency keys. On the second call, it sees the key, looks up the previous result, and returns it — no double assignment.

The rule: **generate the idempotency key before the first attempt, reuse it on all retries**.

---

### Circuit breakers — stop the bleeding

A circuit breaker tracks failure rates to a downstream service. When failures cross a threshold, it "opens" — subsequent calls fail immediately without hitting the service, giving it time to recover.

```
States:
  CLOSED   → calls go through normally, failures are counted
  OPEN     → calls fail immediately (fast failure), no network hit
  HALF-OPEN → one test call allowed through to check recovery
```

**Real scenario — notification service degradation**:

An `order-service` calls `notification-service` after every order to send confirmation emails. `notification-service` starts returning `UNAVAILABLE` — maybe its email provider is down.

Without a circuit breaker:
- Every order triggers a call that hangs for the full timeout
- `order-service` threads pile up waiting
- `order-service` itself starts timing out for callers
- Cascading failure spreads to the checkout flow

With a circuit breaker (configured at 50% failure rate over 10s window):
- After threshold is hit, circuit opens
- `order-service` gets immediate `UNAVAILABLE` from the breaker, not the timeout
- Orders continue to complete — emails are queued or skipped
- `notification-service` recovers, circuit closes, emails resume

The critical insight: **the notification service failing should not take down checkout**. Circuit breakers enforce that boundary.

In practice, circuit breakers live in the service mesh (Istio, Linkerd) or a library like `resilience4j` (Java) or `go-resiliency` (Go), not in your business logic.

---

### Putting it together — a checkout flow

Here's how all four mechanisms work together in a realistic flow:

```
User: POST /checkout
  │
  ├─ API Gateway sets 1000ms deadline on context
  │
  └─ order-service.CreateOrder(ctx, req)
       │
       ├─ inventory-service.Reserve(ctx, items)   ← parallel
       │    • UNAVAILABLE? → retry once (idempotent read-then-lock)
       │    • DEADLINE_EXCEEDED? → abort, return error to user
       │    • Circuit open? → fail fast, show "item unavailable"
       │
       ├─ payment-service.Charge(ctx, amount, idempotency_key)
       │    • UNAVAILABLE? → retry with same idempotency_key
       │    • DEADLINE_EXCEEDED? → check payment status before retry
       │    • ALREADY_EXISTS? → charge succeeded earlier, continue
       │    • Circuit open? → fail fast, don't attempt charge
       │
       └─ notification-service.SendConfirmation(ctx, order)
            • UNAVAILABLE? → circuit breaker trips after threshold
            • Circuit open? → skip silently, enqueue for async retry
            • Non-critical path — failure here doesn't fail the order
```

The pattern: **critical path services** (inventory, payment) get strict deadlines and idempotent retries. **Non-critical services** (notifications, analytics) get circuit breakers and graceful degradation — their failure shouldn't surface to the user.

---

## Real use cases where gRPC shines

### 1. Uber — real-time push to millions of mobile devices
> Ref: [Uber's Next Gen Push Platform on gRPC](https://www.uber.com/en-VN/blog/ubers-next-gen-push-platform-on-grpc/)

Uber's mobile apps (rider, driver, Eats) need to push messages constantly: driver locations, ETAs, trip status, offer notifications. This system is called **RAMEN** (Real-time Asynchronous MEssaging Network).

**Before gRPC:** Uber used Server-Sent Events (SSE) over HTTP/1.1. The driver offer window is only ~30 seconds — if an offer fails to deliver, Uber needs to know immediately to resend. But SSE acknowledgments were batched every 30 seconds. That's a blind spot exactly as long as the offer window. They also had head-of-line blocking: one large message on a slow network stalled the connection, including heartbeats.

**After gRPC:** Bidirectional streaming means acks travel back on the same connection in real time. HTTP/2 eliminates head-of-line blocking. One `.proto` contract replaced per-language SSE client implementations.

**Measured outcome:**
- P95 connection latency improved by **~45%**
- Push success rate increased by **1-2% across all apps**
- Real-time acks now possible — Uber can resend time-sensitive offers within milliseconds of a delivery failure

This is the clearest case for gRPC streaming: not a nice-to-have, but a direct fix to a business problem (missed driver offers = lost revenue).

---

### 2. LinkedIn — 50,000 endpoints migrated off REST
> Ref: [Why LinkedIn chose gRPC+Protobuf over REST+JSON](https://www.linkedin.com/blog/engineering/infrastructure/linkedin-integrates-protocol-buffers-with-rest-li-for-improved-m)

LinkedIn ran their own REST framework called REST.li across ~2,000 internal services and 50,000 endpoints. Java-only, no streaming, no deadline propagation, JSON everywhere.

**The problem:** As payloads grew (LinkedIn Recruiter profiles, Sales Navigator data), JSON serialization became a CPU bottleneck. REST.li also locked them into Java — adding a Python or Go service meant hand-rolling a client.

**What they measured after switching to Protobuf + gRPC:**
- Up to **60% latency reduction** for services with large, complex payloads
- **6.25% throughput gain** for responses
- GC pressure dropped — Protobuf allocates less than JSON parsing in Java

The migration itself was notable: 20 million lines of code, initially projected as 2-3 years, completed in 2-3 quarters using AI-assisted migration tooling.

The LinkedIn case shows gRPC's value isn't just theoretical performance — at scale, the serialization cost of JSON shows up directly in latency numbers.

---

### 3. Dropbox — standardizing failure handling across hundreds of services
> Ref: [Courier: Dropbox migration to gRPC](https://dropbox.tech/infrastructure/courier-dropbox-migration-to-grpc)

Dropbox moved all internal services to gRPC through a wrapper they called **Courier**. The motivation wasn't primarily performance — it was consistency.

**Before Courier:** Each team wrote their own retry logic, their own timeout handling, their own circuit-breaking. Some services had it, some didn't. Incidents would cascade because one service didn't properly handle a downstream timeout.

**What Courier enforces across every service:**
- Mandatory deadline propagation — no call goes out without a deadline
- Per-service, per-method metrics automatically (no instrumentation boilerplate)
- Distributed tracing baked in
- Circuit-breaking as a standard primitive
- Mutual TLS with internal certificates

One concrete performance problem they hit during rollout: TLS handshake throughput. RSA 2048 achieved 1,527 ops/sec. Switching to ECDSA P-256 jumped to 40,410 ops/sec — a **26x improvement** — necessary to not make TLS the bottleneck at their request volume.

The lesson from Dropbox: gRPC's value in large orgs is often **operational standardization** more than raw speed. When everyone uses the same framework, incidents are easier to trace, and reliability practices don't depend on which team owns a service.

---

### 4. Cloudflare DNS — pod-to-pod communication in Kubernetes
> Ref: [Moving k8s communication to gRPC](https://blog.cloudflare.com/moving-k8s-communication-to-grpc/)

Cloudflare's DNS team moved internal Kubernetes pod communication from REST + Kafka to gRPC. The driver: they were transferring large DNS zones over HTTP and hitting payload size constraints and compression headaches.

**Measured deserialization performance (large DNS zone dataset):**
- JSON: **22,647 nanoseconds/op**
- Protobuf: **96 nanoseconds/op**
- That's a **235x improvement**

They also noted latency spikes "dropped in both amplitude and frequency" after switching to HTTP/2 multiplexing — the spikes were caused by REST's per-request connection overhead on bulk operations.

Since Cloudflare controlled both sides of the connection (internal k8s pod-to-pod), they could exploit gRPC streaming for zone transfers — sending large datasets as a stream instead of one giant payload.

This is a good example of the "you control both ends" sweet spot for gRPC. DNS zone data is structured, binary encoding helps a lot, and streaming maps naturally to the transfer pattern.

---

### 5. Netflix Studio — selective field fetching at API scale
> Ref: [Practical API Design at Netflix, Part 1: Using Protobuf FieldMask](https://netflixtechblog.com/practical-api-design-at-netflix-part-1-using-protobuf-fieldmask-35cfdc606518)

Netflix runs ~2,800 Java microservices. Their Studio Engineering team (internal content production tooling, not the streaming product) published a specific pattern: using Protobuf's **FieldMask** to let callers specify exactly which fields they want.

**The problem:** API clients were requesting full objects but only using a few fields. The response included expensive nested data that triggered unnecessary downstream calls — adding latency and error surface. Netflix considered GraphQL (which solves this natively) but noted their "wide usage of gRPC in the backend" made FieldMask the natural fit.

```proto
// Caller specifies: only give me id and name, skip the expensive nested data
GetUserRequest {
  int64 id = 1;
  google.protobuf.FieldMask field_mask = 2; // ["id", "name"]
}
```

The server reads the FieldMask and skips fetching data the caller didn't ask for — no downstream calls for unused fields.

This use case is less about performance benchmarks and more about API design at scale: when you have hundreds of services consuming each other's APIs, the contract needs to let callers be precise about what they need. gRPC's typed schema enables this cleanly.

---

## Where gRPC doesn't fit

gRPC is efficient for service-to-service communication but it's not a universal choice.

### Public-facing APIs

REST is more discoverable. API consumers can use curl, browser DevTools, Postman without any setup. gRPC requires clients to have the generated stubs or use reflection tools. If you're building a public API that developers outside your org will consume, REST (or GraphQL) is the right default.

### Browser clients

`grpc-web` exists but it's a proxy-based workaround — browsers can't speak native gRPC over HTTP/2 due to limitations in the Fetch/XHR APIs. You add Envoy as a middleware to translate. At that point, you might as well ask whether REST would have been simpler.

> **Rule of thumb**: gRPC at the backend boundary, REST or GraphQL at the frontend boundary.

### Simple CRUD services

If your service is a thin wrapper over a database — create, read, update, delete — REST is simpler to reason about, simpler to document, and simpler to test. gRPC's schema-first workflow adds overhead that isn't worth it when you don't need the performance.

### Event-driven / async workflows

gRPC is a request-response (or streaming) protocol. If your use case is "fire an event and don't wait for a response," you want a message broker — Kafka, RabbitMQ, SQS. gRPC doesn't replace async messaging; they solve different problems.

| Communication style | Right tool |
|---|---|
| Synchronous request-response between services | gRPC |
| Public API consumed by third parties | REST |
| Frontend ↔ backend | REST / GraphQL |
| Async events, fan-out, queuing | Kafka, RabbitMQ, SQS |
| Real-time browser updates | WebSockets or SSE |

---

## My takeaways

- gRPC is the right default for **internal service-to-service communication** in a microservice system. The contract enforcement alone is worth it — you stop debugging "what fields does this endpoint actually return" issues.

- The **streaming support** is what makes gRPC genuinely different from just "faster REST." Bidirectional streaming unlocks patterns that are painful to implement otherwise.

- The **tooling tax is real**. You need protoc, language-specific plugins, and teams need to understand the schema-first workflow. Don't reach for gRPC in a small team or early-stage project unless you have a clear reason.

- Deadline propagation is underrated. The idea that every call carries a time budget that flows through the entire chain is a clean way to avoid cascading latency.

- Most companies end up with a **hybrid**: gRPC internally between services, REST externally toward clients. That split makes sense — optimize for performance where you control both ends, optimize for compatibility where you don't.
