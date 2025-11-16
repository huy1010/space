---
title: Redis Guide - Part 1
description: Redis fundamentals core architecture, data structures, key operations, transactions, pub/sub, and persistence basics.
duration: 15 min
date: 2025-11-16
---

These are my personal notes on Redis fundamentals. The core concepts I need to remember: how Redis's single-threaded architecture works, the different data structures (Strings, JSON, Lists, Sets, Sorted Sets, Hashes, and Streams) and when to use each, plus basic operations like transactions, pub/sub, and persistence. This is my reference for the foundation—the building blocks I'll need when working with Redis.

## Core Architecture

### What is Redis?
Redis (Remote Dictionary Server) is an in-memory data structure store that can be used as a database, cache, or message broker. It stores data as key-value pairs in RAM, making it extremely fast for read and write operations.

### Client-Server Model
Redis follows a client-server architecture:
- **Server**: Redis daemon runs on a host (default port 6379)
- **Clients**: Applications connect via TCP/IP or Unix sockets
- **Protocol**: Redis uses a simple text-based protocol (RESP - Redis Serialization Protocol)
- **Connection**: Clients maintain persistent connections to the server

### Single-Threaded Model
Redis uses a single-threaded event loop for command execution:
- **Benefits**: No race conditions, simpler code, predictable behavior
- **I/O Threading** (Redis 6+): Multiple threads for network I/O, single thread for command execution
- **Implications**: One slow command blocks all others

### Memory Model

RAM-based storage:
- All data in memory (primary storage)
- Optional disk persistence (for durability)
- Memory = Dataset size + Overhead (30-40%)
- Fast access but limited by available RAM

### Event Loop (libevent-based)
Redis processes commands through an event loop:
1. Accept connections from clients
2. Read commands from client sockets
3. Execute commands (single-threaded)
4. Write responses back to clients
5. Handle timers/expirations in the background

**Request Flow**: Client sends command → Server queues → Event loop processes → Response sent back

## Data Structures

### String
```bash
SET key "value"          # Set a key-value pair
GET key                  # Get the value of a key
INCR counter             # Increment a number by 1
DECR counter             # Decrement a number by 1
INCRBY counter 5         # Increment a number by specified amount
APPEND key "more text"   # Append text to existing value
STRLEN key               # Get the length of a string value
```

**Use cases**: Counters, simple values, caching

**Internal encoding**: Redis uses SDS (Simple Dynamic String) with three encoding types:
- `int`: 64-bit integer (when value is a number)
- `embstr`: Strings ≤ 44 bytes (embedded string)
- `raw`: Strings > 44 bytes (regular string)

### JSON
```bash
JSON.SET user:1 $ '{"name":"Alice","age":30,"city":"NYC"}'  # Set JSON document
JSON.GET user:1                                             # Get entire document
JSON.GET user:1 $.name                                     # Get specific field (name)
JSON.SET user:1 $.age 31                                   # Update nested field
JSON.ARRAPPEND user:1 $.hobbies '"reading"'                # Add to array
JSON.NUMINCRBY user:1 $.age 1                              # Increment numeric field
```

**Structure**: Native JSON document storage with path-based access. Each JSON value can be an object, array, string, number, boolean, or null.

**Element types**: Full JSON support - objects, arrays, strings, numbers, booleans, null. Access nested values using JSONPath syntax (e.g., `$.name`, `$.hobbies[0]`).

**Use cases**: Storing structured data, user profiles, configuration objects, nested data without serialization

### List
```bash
LPUSH mylist "a" "b" "c"  # Add to left
RPUSH mylist "d"           # Add to right
LPOP mylist                # Remove from left
RPOP mylist                # Remove from right
LRANGE mylist 0 -1         # Get all elements
LLEN mylist                # Get length
```

**Structure**: Ordered collection of elements. Elements are stored in insertion order (can have duplicates).

**Element types**: Each element is a string (binary-safe, up to 512MB per element). To store objects/JSON, serialize them to strings (e.g., JSON.stringify in JavaScript).

**Use cases**: Queues, stacks, timelines

**Internal encoding**: Redis uses `quicklist` (a linked list of ziplists) for efficient memory usage.

**Blocking operations** (useful for queues):
```bash
# Block and wait for item (timeout in seconds)
BLPOP mylist 10  # Block for 10 seconds, returns when item available
BRPOP mylist 0   # Block forever until item available

# Practical queue pattern
RPUSH queue "job1" "job2"  # Add items to right end of list (FIFO queue)
BLPOP queue 0              # Worker blocks and waits, pops from left when item available
```

**Common patterns**:
- **Queue**: `RPUSH` to add, `BLPOP` to consume
- **Stack**: `LPUSH` to add, `LPOP` to remove

### Set
```bash
SADD myset "a" "b" "c"    # Add one or more members to a set
SMEMBERS myset             # Get all members of a set
SISMEMBER myset "a"        # Check if a member exists in set (returns 1 or 0)
SCARD myset                # Count number of members in set
SREM myset "a"             # Remove one or more members from set
```

**Structure**: Unordered collection of unique members (no duplicates allowed). Order is not guaranteed.

**Element types**: Each member is a string (binary-safe, up to 512MB per member). To store objects, serialize them to strings. Redis automatically handles integer strings efficiently (stored as integers internally when possible).

**Use cases**: Unique items, tags, memberships

**Internal encoding**: Redis uses two encodings:
- `intset`: All members are integers ≤ 512 (memory efficient)
- `hashtable`: Otherwise (general purpose)

**Advanced operations**:
```bash
# Random operations
SRANDMEMBER myset 2        # Get 2 random members (without removing)
SPOP myset                 # Pop and return random member

# Move between sets
SMOVE source dest "member" # Move member from source to dest

# Set operations (union, intersection, difference)
SINTER set1 set2 set3      # Intersection (common members)
SUNION set1 set2           # Union (all members)
SDIFF set1 set2            # Difference (members in set1 but not set2)
SINTERSTORE result set1 set2  # Store intersection in result
```

### Sorted Set
```bash
ZADD leaderboard 100 "player1" 200 "player2"  # Add members with scores (score member pairs)
ZRANGE leaderboard 0 -1 WITHSCORES            # Get all members with scores (0 to -1 = all)
ZRANK leaderboard "player1"                  # Get rank of member (0-based, ascending order)
ZSCORE leaderboard "player1"                 # Get score of a member
```

**Structure**: Collection of unique members, each with an associated numeric score. Ordered by score (ascending by default). Members are unique, but scores can be duplicated.

**Element types**:
- **Members**: Strings (binary-safe, up to 512MB per member). To store objects, serialize them to strings.
- **Scores**: Floating-point numbers (64-bit double precision). Used for ordering.

**Use cases**: Leaderboards, rankings, time-series

**Internal encoding**: Redis uses two encodings:
- `ziplist`: Small sorted sets (memory efficient)
- `skiplist + hashtable`: Large sorted sets (fast lookups)

**Advanced operations**:
```bash
# Score operations
ZINCRBY leaderboard 50 "player1"  # Increment score by 50

# Rank operations
ZRANK leaderboard "player1"        # 0-based rank (ascending)
ZREVRANK leaderboard "player1"     # 0-based rank (descending)

# Range operations
ZRANGE leaderboard 0 9 WITHSCORES  # Top 10 (ascending)
ZREVRANGE leaderboard 0 9 WITHSCORES # Top 10 (descending)
ZRANGEBYSCORE leaderboard 100 500   # Members with score 100-500
ZREVRANGEBYSCORE leaderboard 500 100 # Reverse score range

# Lex operations (when all scores are same, useful for autocomplete)
ZADD autocomplete 0 "apple" 0 "application" 0 "apply"
ZRANGEBYLEX autocomplete [app (appz  # Lexicographic range

# Remove operations
ZREMRANGEBYRANK leaderboard 10 -1   # Keep top 10
ZREMRANGEBYSCORE leaderboard 0 99   # Remove scores 0-99
```

### Hash
```bash
HSET user:1 name "Alice" age 30  # Set one or more field-value pairs in a hash
HGET user:1 name                  # Get value of a specific field
HGETALL user:1                    # Get all fields and values in a hash
HINCRBY user:1 age 1             # Increment numeric value of a field by integer
```

**Use cases**: Objects, user profiles, configurations

**Internal encoding**: Redis uses two encodings:
- `ziplist`: Small hashes (≤512 fields, ≤64 byte values) - memory efficient
- `hashtable`: Large hashes - general purpose

**Advanced operations**:
```bash
# Set multiple fields at once
HMSET user:1 email "alice@mail.com" phone "123456"  # Set multiple fields (deprecated, use HSET instead)
HSET user:1 name "Alice" age 30 city "NYC"  # Modern way: HSET also supports multiple field-value pairs

# Increment operations
HINCRBY user:1 age 1           # Integer increment
HINCRBYFLOAT user:1 balance 10.50  # Float increment

# Field operations
HEXISTS user:1 email           # Check if field exists
HLEN user:1                    # Number of fields
HKEYS user:1                   # Get all field names
HVALS user:1                   # Get all values

# Scan large hashes (for memory efficiency)
HSCAN user:1 0 MATCH "field*" COUNT 100  # Iterate with pattern matching
```

### Streams

```bash
# Add entries
XADD mystream * field1 value1 field2 value2
XADD mystream MAXLEN ~ 1000 * data "value"  # Approximate capping

# Read entries
XREAD COUNT 10 STREAMS mystream 0
XREAD BLOCK 5000 STREAMS mystream $  # Block for new entries

# Range queries
XRANGE mystream - +  # All entries
XRANGE mystream 1609459200000 1609545600000  # Time range
XREVRANGE mystream + - COUNT 10  # Last 10 entries

# Consumer Groups
XGROUP CREATE mystream mygroup 0 MKSTREAM
XREADGROUP GROUP mygroup consumer1 COUNT 1 STREAMS mystream >

# Acknowledge messages
XACK mystream mygroup <message-id>

# Pending entries
XPENDING mystream mygroup
XCLAIM mystream mygroup consumer2 3600000 <message-id>  # Claim after 1 hour

# Delete entries
XDEL mystream <message-id>
XTRIM mystream MAXLEN 1000
```

**Use cases**: Reliable messaging, event streaming, time-series data

> I haven't worked with this data structure yet :D, but it's good to know.

## Basic Operations

Essential operations for working with Redis: managing keys and executing transactions. These are the fundamental commands you'll use in almost every Redis application.

### Key Management

Basic commands for working with keys and their values.

```bash
SET key "value"        # Set a key-value pair (creates or overwrites)
GET key                # Get the value of a key
DEL key                # Delete a key
EXISTS key             # Check if a key exists (returns 1 or 0)
EXPIRE key 3600        # Set expiration time in seconds (key expires after 1 hour)
TTL key                # Check remaining time-to-live in seconds (-1 = no expiry, -2 = key doesn't exist)
KEYS pattern*          # ⚠️ Find keys matching pattern (AVOID in production - blocks Redis, use SCAN instead)
```

**Use cases**:
- `SET/GET`: Basic read/write operations for any data
- `EXISTS`: Check if data exists before operations
- `EXPIRE/TTL`: Implement time-based expiration (sessions, cache, temporary data)
- `DEL`: Remove data when no longer needed

### Transactions

Execute multiple commands atomically (all or nothing). Useful when you need to ensure several operations succeed together.

```bash
MULTI                 # Start a transaction
SET key1 "value1"
SET key2 "value2"
INCR counter
EXEC                  # Execute all queued commands atomically
```

**How it works**:
1. `MULTI` starts transaction mode - commands are queued, not executed
2. Commands are added to queue
3. `EXEC` executes all commands atomically
4. If any command fails, others still execute (no rollback)

**Use cases**:
- Update multiple related keys together
- Ensure consistency across operations
- Batch operations for better performance

**Important**: Redis transactions don't support rollback. If a command fails, others still execute. Check return values to handle errors.

## Persistence

Redis stores data in memory by default, but persistence options allow data to survive restarts. Two main approaches:

**RDB (Redis Database Backup)**: Takes periodic snapshots of the entire dataset and saves it as a single binary file (dump.rdb). Think of it like taking a photo of your data at specific intervals. It's fast and compact, but you might lose data between snapshots. Best for backups, disaster recovery, and when you can tolerate some data loss.

**AOF (Append-Only File)**: Logs every write command to a file as it happens, like a transaction log. On restart, Redis replays these commands to rebuild the dataset. More durable than RDB but produces larger files. Best when you need maximum durability and can't afford data loss.

You can use both together (hybrid persistence) for the best of both worlds: RDB for fast recovery and AOF for durability.

### RDB (Redis Database Backup)
Point-in-time snapshots of the dataset.

```bash
# redis.conf
save 900 1      # After 900s if 1 key changed
save 300 10     # After 300s if 10 keys changed
save 60 10000   # After 60s if 10000 keys changed
```

| Pros | Cons |
|------|------|
| Compact single file | Data loss possible (up to last snapshot) |
| Fast restarts | CPU intensive during save |
| Good for backups | Fork can be slow for large datasets |

### AOF (Append-Only File)
Logs every write operation to a file.

```bash
# redis.conf
appendonly yes
appendfsync everysec   # Good balance (default)
```

| Pros | Cons |
|------|------|
| Better durability | Larger file size |
| Can recover more data | Slower than RDB |
| More granular recovery | Requires rewrite for optimization |

## Key Notes

1. **Always set expiration** on keys to prevent memory leaks
2. **Use appropriate data structures** - Hashes for objects, Sets for unique items
3. **Avoid KEYS command** in production - use SCAN instead
4. **Use pipelining** for multiple operations
5. **Monitor memory usage** - set maxmemory and eviction policy

---

**Continue reading:** [Redis Guide - Part 2](./redis-intermediate)
