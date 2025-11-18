---
title: Redis Guide - Part 2
description: Redis persistence strategies (RDB/AOF), replication, high availability with Sentinel, transactions, Lua scripting, pipelines, memory management, eviction policies, security, and performance optimization.
duration: 20 min
date: 2025-11-21
---

Moving beyond the basics, these notes cover what's needed for running Redis in production. Topics include persistence strategies to keep data safe, replication and high availability setups, and performance optimization techniques. Also covered: Lua scripting for complex operations, pipelining for better throughput, memory management, security practices, and monitoring tools.

## Persistence & Reliability

### RDB (Redis Database Backup)
Point-in-time snapshots.

```conf
# redis.conf
save 900 1      # After 900s if 1 key changed
save 300 10     # After 300s if 10 keys changed
save 60 10000   # After 60s if 10000 keys changed

dbfilename dump.rdb
dir /var/lib/redis
rdbcompression yes
rdbchecksum yes
```

**Pros**:
- Compact single file
- Fast restarts
- Good for backups

**Cons**:
- Data loss possible (up to last snapshot)
- Fork can be slow for large datasets
- CPU intensive during save

**Manual snapshots**:
```redis
SAVE      # Blocking
BGSAVE    # Background (forks)
LASTSAVE  # Timestamp of last save
```

### AOF (Append-Only File)
Logs every write operation.

```conf
# redis.conf
appendonly yes
appendfilename "appendonly.aof"

# Fsync policies
appendfsync always     # Slow, safest
appendfsync everysec   # Good balance (default)
appendfsync no         # Fast, least safe

# Rewriting
auto-aof-rewrite-percentage 100
auto-aof-rewrite-min-size 64mb
```

**Manual rewrite**:
```redis
BGREWRITEAOF
```

**AOF Rewrite**: Compacts AOF by regenerating commands from current dataset.

### Hybrid Persistence (Redis 4.0+)
```conf
aof-use-rdb-preamble yes
```
AOF file contains RDB snapshot + subsequent commands.

**Recovery Order**:
1. AOF (if enabled)
2. RDB (if AOF not present)

### Replication

#### Master-Replica Architecture

```conf
# On replica
replicaof <master-ip> <master-port>
masterauth <password>

# Replica settings
replica-read-only yes
replica-serve-stale-data yes
repl-diskless-sync yes
repl-diskless-sync-delay 5
```

#### Replication Process
1. **Replica connects** to master
2. **PSYNC** command sent
3. **Full sync** (RDB transfer) or **partial sync** (replication backlog)
4. **Continuous replication** via command stream

#### Commands
```redis
# On master
INFO replication
ROLE

# On replica
REPLICAOF <host> <port>
REPLICAOF NO ONE  # Promote to master

# Replication lag
INFO replication | grep lag
```

#### Replication Backlog
```conf
repl-backlog-size 1mb
repl-backlog-ttl 3600
```
Circular buffer for partial resync after disconnection.

#### Diskless Replication
```conf
repl-diskless-sync yes
repl-diskless-sync-delay 5
```
Streams RDB directly to replicas without touching disk.

### High Availability (Sentinel)

#### Architecture
```
Sentinel 1 -----> Master
Sentinel 2 -----> Replica 1
Sentinel 3 -----> Replica 2
```

#### Configuration
```conf
# sentinel.conf
sentinel monitor mymaster 127.0.0.1 6379 2  # Quorum = 2
sentinel auth-pass mymaster password
sentinel down-after-milliseconds mymaster 5000
sentinel parallel-syncs mymaster 1
sentinel failover-timeout mymaster 180000

# Notification scripts
sentinel notification-script mymaster /path/to/script.sh
sentinel client-reconfig-script mymaster /path/to/reconfig.sh
```

#### Sentinel Commands
```redis
SENTINEL masters
SENTINEL master mymaster
SENTINEL replicas mymaster
SENTINEL sentinels mymaster
SENTINEL get-master-addr-by-name mymaster

# Force failover
SENTINEL failover mymaster

# Remove/Add monitoring
SENTINEL remove mymaster
SENTINEL monitor mymaster 127.0.0.1 6379 2
```

#### Failover Process
1. **Detection**: Sentinels detect master down
2. **Quorum**: Enough sentinels agree (quorum)
3. **Election**: Sentinels elect a leader
4. **Promotion**: Leader promotes a replica
5. **Reconfiguration**: Other replicas reconfigured
6. **Notification**: Clients informed

#### Client Connection
```python
from redis.sentinel import Sentinel

sentinel = Sentinel([
    ('localhost', 26379),
    ('localhost', 26380),
    ('localhost', 26381)
], socket_timeout=0.1)

master = sentinel.master_for('mymaster', socket_timeout=0.1)
slave = sentinel.slave_for('mymaster', socket_timeout=0.1)

master.set('key', 'value')
value = slave.get('key')
```

## Operations & Features

### Transactions

#### MULTI/EXEC
```redis
MULTI
SET key1 "value1"
SET key2 "value2"
INCR counter
EXEC
```

**Characteristics**:
- Commands queued
- Executed atomically
- No rollback (all or nothing execution)
- Errors detected at EXEC time

#### WATCH (Optimistic Locking)
```redis
WATCH key1
val = GET key1
# ... computation ...
MULTI
SET key1 new_val
EXEC  # Fails if key1 changed since WATCH
```

#### DISCARD
```redis
MULTI
SET key "value"
DISCARD  # Cancel transaction
```

#### Error Handling
```redis
MULTI
SET key value
INCR key  # Error: not an integer
EXEC
# All commands execute, errors returned individually
```

### Pub/Sub

#### Basic Pub/Sub
```redis
# Publisher
PUBLISH channel1 "message"

# Subscriber
SUBSCRIBE channel1 channel2
UNSUBSCRIBE channel1

# Pattern matching
PSUBSCRIBE news.*
PUNSUBSCRIBE news.*
```

#### Pub/Sub Commands
```redis
PUBSUB CHANNELS [pattern]
PUBSUB NUMSUB channel [channel ...]
PUBSUB NUMPAT
```

#### Python Example
```python
import redis

# Subscriber
r = redis.Redis()
pubsub = r.pubsub()
pubsub.subscribe('channel1')

for message in pubsub.listen():
    print(message)

# Publisher
r.publish('channel1', 'Hello World')
```

#### Limitations
- **No message persistence**: Messages lost if no subscribers
- **Fire and forget**: No delivery guarantees
- **No message history**

#### Alternative: Streams
Use Streams for reliable messaging with persistence.

### Lua Scripting

#### EVAL
```redis
EVAL "return redis.call('SET', KEYS[1], ARGV[1])" 1 mykey myvalue
```

#### Script Caching (EVALSHA)
```redis
# Load script
SCRIPT LOAD "return redis.call('GET', KEYS[1])"
# Returns: SHA1 hash

# Execute by hash
EVALSHA <sha1> 1 mykey
```

#### Complex Example: Rate Limiting
```lua
local key = KEYS[1]
local limit = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local current = tonumber(redis.call('GET', key) or "0")

if current >= limit then
    return 0
else
    redis.call('INCR', key)
    if current == 0 then
        redis.call('EXPIRE', key, window)
    end
    return 1
end
```

```redis
EVAL "..." 1 "user:1000:requests" 100 60
```

#### Atomic Counter with HINCRBY
```lua
local key = KEYS[1]
local field = ARGV[1]
local increment = tonumber(ARGV[2])
local max = tonumber(ARGV[3])

local current = tonumber(redis.call('HGET', key, field) or "0")
if current + increment <= max then
    return redis.call('HINCRBY', key, field, increment)
else
    return nil
end
```

#### Script Management
```redis
SCRIPT LOAD "script"
SCRIPT EXISTS sha1 [sha1 ...]
SCRIPT FLUSH
SCRIPT KILL  # Kill running script
```

#### Best Practices
- Keep scripts short
- Use `KEYS` and `ARGV` for parameters
- Cache with EVALSHA
- Test thoroughly (no rollback)
- Avoid long-running scripts (blocks Redis)

### Pipeline & Batch Operations

#### Pipelining
Send multiple commands without waiting for responses.

```python
import redis

r = redis.Redis()
pipe = r.pipeline()

pipe.set('key1', 'value1')
pipe.set('key2', 'value2')
pipe.get('key1')
pipe.incr('counter')

results = pipe.execute()
# Returns: [True, True, b'value1', 1]
```

**Benefits**:
- Reduced RTT (Round Trip Time)
- Higher throughput
- 10-100x faster for bulk operations

#### Transaction Pipeline
```python
pipe = r.pipeline(transaction=True)
pipe.multi()
pipe.set('key', 'value')
pipe.incr('counter')
pipe.execute()
```

#### MGET/MSET
```redis
MSET key1 "value1" key2 "value2" key3 "value3"
MGET key1 key2 key3
# Returns: ["value1", "value2", "value3"]

MSETNX key1 "value1" key2 "value2"  # Atomic, all or nothing
```

## Memory & Performance

### Memory Management

#### Memory Analysis
```redis
INFO memory
MEMORY USAGE key [SAMPLES count]
MEMORY DOCTOR
MEMORY STATS
MEMORY MALLOC-STATS
```

#### Key Space Analysis
```bash
redis-cli --bigkeys
redis-cli --memkeys
redis-cli --scan --pattern "user:*"
```

#### Memory Optimization

##### 1. Use Hashes for Small Objects
```redis
# Bad: 1000 keys
SET user:1:name "Alice"
SET user:1:email "alice@mail.com"
# ... repeat for 1000 users

# Good: 1 hash per user
HSET user:1 name "Alice" email "alice@mail.com"
```

##### 2. Ziplist Optimization
```conf
hash-max-ziplist-entries 512
hash-max-ziplist-value 64
list-max-ziplist-size -2
set-max-intset-entries 512
zset-max-ziplist-entries 128
zset-max-ziplist-value 64
```

##### 3. Key Naming
```redis
# Bad: Long keys
SET "user:information:profile:name:123456789" "Alice"

# Good: Short keys
SET "u:123456789:n" "Alice"
```

##### 4. String Sharing
Redis shares small integer strings (0-9999 by default).

#### Memory Limits
```conf
maxmemory 2gb
maxmemory-policy allkeys-lru
```

### Eviction Policies

#### Available Policies

```conf
maxmemory-policy <policy>
```

**Policies**:
- `noeviction`: Return errors when memory limit reached (default)
- `allkeys-lru`: Evict least recently used keys
- `allkeys-lfu`: Evict least frequently used keys (Redis 4.0+)
- `allkeys-random`: Evict random keys
- `volatile-lru`: Evict LRU keys with TTL
- `volatile-lfu`: Evict LFU keys with TTL
- `volatile-random`: Evict random keys with TTL
- `volatile-ttl`: Evict keys with shortest TTL

#### LRU vs LFU

**LRU (Least Recently Used)**:
- Good for: Time-sensitive data
- Evicts: Keys not accessed recently

**LFU (Least Frequently Used)**:
- Good for: Access frequency matters
- Evicts: Keys accessed rarely
- Decay over time

```conf
lfu-log-factor 10
lfu-decay-time 1
```

#### Eviction Process
1. Random sampling (maxmemory-samples)
2. Select victim by policy
3. Evict and free memory
4. Repeat if needed

```conf
maxmemory-samples 5  # Higher = more accurate, slower
```

## Security

### Authentication
```conf
# redis.conf
requirepass your_strong_password

# ACL (Redis 6+)
aclfile /etc/redis/users.acl
```

```redis
AUTH password

# ACL commands
ACL LIST
ACL USERS
ACL GETUSER username
ACL SETUSER username on >password ~* +@all
ACL DELUSER username
ACL WHOAMI
```

### ACL Examples
```redis
# Read-only user
ACL SETUSER readonly on >pass123 ~* -@all +@read

# Admin user
ACL SETUSER admin on >admin123 ~* +@all

# Limited user
ACL SETUSER limited on >pass ~user:* +get +set +del

# Pattern matching
ACL SETUSER analytics on >pass ~analytics:* +@read +@write
```

### Network Security
```conf
# Bind to specific interfaces
bind 127.0.0.1 192.168.1.100

# Disable protected mode (careful!)
protected-mode yes

# Rename dangerous commands
rename-command FLUSHDB ""
rename-command FLUSHALL ""
rename-command CONFIG "CONFIG_abc123"
rename-command SHUTDOWN "SHUTDOWN_xyz789"
```

### TLS/SSL (Redis 6+)
```conf
tls-port 6380
tls-cert-file /path/to/redis.crt
tls-key-file /path/to/redis.key
tls-ca-cert-file /path/to/ca.crt
tls-auth-clients yes
```

### Client Connection Limits
```conf
maxclients 10000
timeout 300  # Close idle connections after 300s
tcp-keepalive 300
```

## Performance Optimization

### Latency Analysis
```redis
SLOWLOG GET 10
SLOWLOG LEN
SLOWLOG RESET

LATENCY DOCTOR
LATENCY HISTORY event
LATENCY LATEST
LATENCY RESET
```

### Slow Log Configuration
```conf
slowlog-log-slower-than 10000  # Microseconds
slowlog-max-len 128
```

### Benchmarking
```bash
redis-benchmark -q -n 100000
redis-benchmark -t set,get -n 100000 -q
redis-benchmark -q script load "return 1"

# Custom benchmark
redis-benchmark -n 100000 -q -r 100000 -P 16 \
  LPUSH mylist __rand_int__
```

### Client-Side Optimization

#### 1. Connection Pooling
```python
import redis

pool = redis.ConnectionPool(
    host='localhost',
    port=6379,
    max_connections=50,
    decode_responses=True
)

r = redis.Redis(connection_pool=pool)
```

#### 2. Use Pipeline
```python
# Bad: 1000 RTTs
for i in range(1000):
    r.set(f'key:{i}', i)

# Good: 1 RTT
pipe = r.pipeline()
for i in range(1000):
    pipe.set(f'key:{i}', i)
pipe.execute()
```

#### 3. Batch Operations
```python
# Use MGET/MSET instead of multiple GET/SET
r.mset({'key1': 'val1', 'key2': 'val2'})
r.mget(['key1', 'key2'])
```

### Server-Side Optimization

#### 1. Disable Persistence for Cache
```conf
save ""
appendonly no
```

#### 2. Use Appropriate Data Structures
```redis
# Bad: 1000 string keys for user data
SET user:1:name "Alice"
SET user:1:email "alice@mail.com"

# Good: 1 hash
HSET user:1 name "Alice" email "alice@mail.com"
```

#### 3. Key Expiration
```redis
EXPIRE key 3600
SETEX key 3600 "value"
```

#### 4. Lazy Freeing (Redis 4.0+)
```conf
lazyfree-lazy-eviction yes
lazyfree-lazy-expire yes
lazyfree-lazy-server-del yes
replica-lazy-flush yes
```

```redis
UNLINK key  # Async delete instead of DEL
FLUSHALL ASYNC
FLUSHDB ASYNC
```

## Monitoring & Debugging

### INFO Command
```redis
INFO server
INFO clients
INFO memory
INFO persistence
INFO stats
INFO replication
INFO cpu
INFO keyspace
INFO cluster
```

### Key Monitoring Metrics
```redis
INFO stats | grep instantaneous_ops_per_sec
INFO stats | grep rejected_connections
INFO stats | grep evicted_keys
INFO memory | grep used_memory_human
INFO memory | grep mem_fragmentation_ratio
```

### CLIENT Commands
```redis
CLIENT LIST
CLIENT KILL ip:port
CLIENT GETNAME
CLIENT SETNAME connection-name
CLIENT PAUSE timeout
CLIENT REPLY ON|OFF|SKIP
```

### MONITOR (Use Carefully!)
```redis
MONITOR  # Shows all commands in real-time
# WARNING: Huge performance impact in production
```

### Key Space Notifications
```conf
notify-keyspace-events Ex  # Expired events
```

```python
import redis

r = redis.Redis()
pubsub = r.pubsub()
pubsub.psubscribe('__keyevent@0__:expired')

for message in pubsub.listen():
    print(f"Key expired: {message}")
```

**Event types**:
- `K`: Keyspace events
- `E`: Keyevent events
- `g`: Generic commands (DEL, EXPIRE, etc.)
- `$`: String commands
- `l`: List commands
- `s`: Set commands
- `h`: Hash commands
- `z`: Sorted set commands
- `x`: Expired events
- `e`: Evicted events

### External Monitoring Tools
- **Redis Exporter** + Prometheus + Grafana
- **RedisInsight**: GUI tool by Redis Labs
- **redis-stat**: Ruby-based monitoring
- **redis-rdb-tools**: Analyze RDB files

---

**Navigation:** [← Part 1](./redis-beginner) | [Part 3 →](./redis-advanced)
