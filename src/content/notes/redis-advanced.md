---
title: Redis Guide - Part 3
description: Redis clustering, advanced patterns, client-side caching, Redis modules, and production best practices including deployment, monitoring, backup, disaster recovery, and scaling strategies.
duration: 20 min
date: 2025-11-21
---

Advanced Redis notes—the stuff needed when things get serious. Covers clustering for horizontal scaling, advanced patterns like distributed locks and rate limiting, and client-side caching strategies. Also includes notes on Redis modules (search, JSON, graph databases, time-series) and production best practices: deployment strategies, monitoring, backup procedures, disaster recovery, and scaling approaches.

## Clustering

### Redis Cluster Architecture
- **16384 hash slots** distributed across nodes
- **Minimum 3 master nodes**
- Each master can have replicas
- No single point of failure
- Automatic failover

### Hash Slot Calculation
```python
HASH_SLOT = CRC16(key) mod 16384
```

### Hash Tags
```redis
# These keys go to same slot
SET {user:1000}:profile "data"
SET {user:1000}:sessions "data"
```

### Cluster Configuration
```conf
# redis.conf
cluster-enabled yes
cluster-config-file nodes-6379.conf
cluster-node-timeout 15000
cluster-replica-validity-factor 10
cluster-migration-barrier 1
cluster-require-full-coverage yes
```

### Creating Cluster
```bash
# Create 6 nodes (3 masters, 3 replicas)
redis-cli --cluster create \
  127.0.0.1:7000 127.0.0.1:7001 127.0.0.1:7002 \
  127.0.0.1:7003 127.0.0.1:7004 127.0.0.1:7005 \
  --cluster-replicas 1
```

### Cluster Commands
```redis
CLUSTER INFO
CLUSTER NODES
CLUSTER SLOTS
CLUSTER KEYSLOT <key>
CLUSTER COUNTKEYSINSLOT <slot>
CLUSTER GETKEYSINSLOT <slot> <count>

# Resharding
CLUSTER ADDSLOTS <slot> [slot ...]
CLUSTER DELSLOTS <slot> [slot ...]
CLUSTER SETSLOT <slot> NODE <node-id>

# Failover
CLUSTER FAILOVER [FORCE|TAKEOVER]

# Replica management
CLUSTER REPLICATE <node-id>
CLUSTER RESET [HARD|SOFT]
```

### Multi-Key Operations
```redis
# CROSSSLOT error if keys in different slots
MGET key1 key2  # May fail

# Use hash tags
MGET {user:1000}:name {user:1000}:email  # Same slot
```

### Resharding
```bash
redis-cli --cluster reshard 127.0.0.1:7000
redis-cli --cluster rebalance 127.0.0.1:7000
redis-cli --cluster check 127.0.0.1:7000
```

### Client-Side
```python
from redis.cluster import RedisCluster

rc = RedisCluster(
    startup_nodes=[
        {"host": "127.0.0.1", "port": "7000"},
        {"host": "127.0.0.1", "port": "7001"}
    ],
    decode_responses=True,
    skip_full_coverage_check=True
)

rc.set('key', 'value')
```

## Advanced Patterns

### 1. Distributed Locks (Redlock Algorithm)

```python
import redis
import time
import uuid

class RedisLock:
    def __init__(self, redis_clients, resource, ttl=10):
        self.clients = redis_clients
        self.resource = resource
        self.ttl = ttl
        self.token = str(uuid.uuid4())

    def acquire(self):
        acquired = 0
        start_time = time.time()

        for client in self.clients:
            try:
                result = client.set(
                    self.resource,
                    self.token,
                    nx=True,
                    ex=self.ttl
                )
                if result:
                    acquired += 1
            except:
                pass

        elapsed = time.time() - start_time
        validity_time = self.ttl - elapsed - 0.001

        if acquired >= len(self.clients) // 2 + 1 and validity_time > 0:
            return True
        else:
            self.release()
            return False

    def release(self):
        script = """
        if redis.call("get", KEYS[1]) == ARGV[1] then
            return redis.call("del", KEYS[1])
        else
            return 0
        end
        """
        for client in self.clients:
            try:
                client.eval(script, 1, self.resource, self.token)
            except:
                pass
```

### 2. Rate Limiting

#### Sliding Window Counter
```lua
local key = KEYS[1]
local window = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local now = tonumber(ARGV[3])

redis.call('ZREMRANGEBYSCORE', key, 0, now - window)
local count = redis.call('ZCARD', key)

if count < limit then
    redis.call('ZADD', key, now, now)
    redis.call('EXPIRE', key, window)
    return 1
else
    return 0
end
```

#### Fixed Window
```redis
MULTI
INCR rate:user:1000:2024-01-15-14
EXPIRE rate:user:1000:2024-01-15-14 3600
EXEC
```

### 3. Caching Patterns

#### Cache-Aside
```python
def get_user(user_id):
    # Try cache first
    user = redis.get(f'user:{user_id}')
    if user:
        return json.loads(user)

    # Cache miss, fetch from DB
    user = db.get_user(user_id)

    # Store in cache
    redis.setex(
        f'user:{user_id}',
        3600,
        json.dumps(user)
    )
    return user
```

#### Write-Through
```python
def update_user(user_id, data):
    # Update DB
    db.update_user(user_id, data)

    # Update cache
    redis.setex(
        f'user:{user_id}',
        3600,
        json.dumps(data)
    )
```

#### Write-Behind (Write-Back)
```python
def update_user(user_id, data):
    # Update cache immediately
    redis.setex(f'user:{user_id}', 3600, json.dumps(data))

    # Queue for async DB write
    redis.lpush('write_queue', json.dumps({
        'user_id': user_id,
        'data': data
    }))
```

### 4. Leaderboard
```python
def add_score(user_id, score):
    redis.zadd('leaderboard', {user_id: score})

def get_rank(user_id):
    rank = redis.zrevrank('leaderboard', user_id)
    return rank + 1 if rank is not None else None

def get_top(n):
    return redis.zrevrange('leaderboard', 0, n-1, withscores=True)

def get_around_user(user_id, offset=2):
    rank = redis.zrevrank('leaderboard', user_id)
    if rank is None:
        return []

    start = max(0, rank - offset)
    end = rank + offset
    return redis.zrevrange('leaderboard', start, end, withscores=True)
```

### 5. Session Management
```python
import json
import uuid

def create_session(user_id, data):
    session_id = str(uuid.uuid4())
    redis.setex(
        f'session:{session_id}',
        3600,  # 1 hour TTL
        json.dumps({'user_id': user_id, **data})
    )
    return session_id

def get_session(session_id):
    data = redis.get(f'session:{session_id}')
    return json.loads(data) if data else None

def extend_session(session_id):
    redis.expire(f'session:{session_id}', 3600)

def destroy_session(session_id):
    redis.delete(f'session:{session_id}')
```

### 6. Inventory/Stock Management
```lua
-- Atomic stock decrement with validation
local key = KEYS[1]
local quantity = tonumber(ARGV[1])
local current = tonumber(redis.call('GET', key) or "0")

if current >= quantity then
    redis.call('DECRBY', key, quantity)
    return current - quantity
else
    return -1  -- Insufficient stock
end
```

```python
def reserve_stock(product_id, quantity):
    script = """
    local key = KEYS[1]
    local quantity = tonumber(ARGV[1])
    local current = tonumber(redis.call('GET', key) or "0")

    if current >= quantity then
        redis.call('DECRBY', key, quantity)
        return current - quantity
    else
        return -1
    end
    """

    result = redis.eval(script, 1, f'stock:{product_id}', quantity)
    return result >= 0
```

### 7. Real-Time Analytics
```python
# Page views counter
def track_pageview(page_id, date):
    redis.hincrby(f'pageviews:{date}', page_id, 1)

# Unique visitors with HyperLogLog
def track_visitor(page_id, user_id):
    redis.pfadd(f'visitors:{page_id}', user_id)

def get_unique_visitors(page_id):
    return redis.pfcount(f'visitors:{page_id}')

# Time-series data
def track_metric(metric_name, value, timestamp):
    redis.zadd(f'metrics:{metric_name}', {timestamp: value})

def get_metrics_range(metric_name, start, end):
    return redis.zrangebyscore(
        f'metrics:{metric_name}',
        start,
        end,
        withscores=True
    )
```

### 8. Circular Buffer
```python
def add_to_buffer(key, value, max_size=1000):
    pipe = redis.pipeline()
    pipe.lpush(key, value)
    pipe.ltrim(key, 0, max_size - 1)
    pipe.execute()

def get_recent_items(key, count=10):
    return redis.lrange(key, 0, count - 1)
```

### 9. Geofencing
```python
def add_location(user_id, longitude, latitude):
    redis.geoadd('locations', longitude, latitude, user_id)

def find_nearby_users(longitude, latitude, radius_km):
    return redis.georadius(
        'locations',
        longitude,
        latitude,
        radius_km,
        unit='km',
        withdist=True,
        withcoord=True
    )

def get_distance(user1_id, user2_id):
    return redis.geodist('locations', user1_id, user2_id, unit='km')
```

### 10. Job Queue
```python
import json

def enqueue_job(queue_name, job_data):
    job_id = str(uuid.uuid4())
    job = {'id': job_id, 'data': job_data}
    redis.lpush(f'queue:{queue_name}', json.dumps(job))
    return job_id

def dequeue_job(queue_name, timeout=0):
    result = redis.brpop(f'queue:{queue_name}', timeout)
    if result:
        _, job_json = result
        return json.loads(job_json)
    return None

def get_queue_length(queue_name):
    return redis.llen(f'queue:{queue_name}')
```

## Client-Side Caching

### Tracking (Redis 6+)
```redis
CLIENT TRACKING ON
GET key1
GET key2

# Server sends invalidation messages when keys change
```

### Python Example
```python
import redis

r = redis.Redis()

# Enable tracking
r.execute_command('CLIENT', 'TRACKING', 'ON')

# Read data (cached on client side)
value = r.get('key1')

# When 'key1' changes on server, client receives invalidation
```

### Broadcast Mode
```redis
CLIENT TRACKING ON BCAST PREFIX user: PREFIX product:
```

### Client-Side Cache Implementation
```python
import redis
import threading
import time

class CachedRedis:
    def __init__(self):
        self.redis = redis.Redis()
        self.cache = {}
        self.lock = threading.Lock()

        # Subscribe to invalidation messages
        self.pubsub = self.redis.pubsub()
        self.redis.execute_command('CLIENT', 'TRACKING', 'ON')

        # Start invalidation listener
        threading.Thread(target=self._listen_invalidations, daemon=True).start()

    def get(self, key):
        with self.lock:
            if key in self.cache:
                return self.cache[key]

        value = self.redis.get(key)

        with self.lock:
            self.cache[key] = value

        return value

    def _listen_invalidations(self):
        # Handle invalidation messages
        pass
```

## Redis Modules

### RediSearch
Full-text search and secondary indexing.

```redis
# Create index
FT.CREATE idx:users ON HASH PREFIX 1 user: SCHEMA
  name TEXT SORTABLE
  email TAG
  age NUMERIC SORTABLE
  city TAG

# Add data (automatically indexed)
HSET user:1 name "Alice Smith" email "alice@mail.com" age 30 city "NYC"
HSET user:2 name "Bob Johnson" email "bob@mail.com" age 25 city "LA"

# Search
FT.SEARCH idx:users "@name:alice"
FT.SEARCH idx:users "@city:{NYC} @age:[25 35]"
FT.SEARCH idx:users "@name:(alice | bob)"

# Aggregations
FT.AGGREGATE idx:users "*"
  GROUPBY 1 @city
  REDUCE COUNT 0 AS count

# Auto-complete
FT.SUGADD autocomplete "Alice Smith" 100
FT.SUGGET autocomplete "ali" FUZZY
```

### RedisJSON
Native JSON document storage.

```redis
# Set JSON document
JSON.SET user:1 $ '{"name":"Alice","age":30,"hobbies":["reading","coding"]}'

# Get entire document
JSON.GET user:1

# Get specific path
JSON.GET user:1 $.name

# Update nested field
JSON.SET user:1 $.age 31

# Array operations
JSON.ARRAPPEND user:1 $.hobbies '"gaming"'
JSON.ARRPOP user:1 $.hobbies 0

# Numeric operations
JSON.NUMINCRBY user:1 $.age 1

# Object operations
JSON.OBJKEYS user:1 $
JSON.OBJLEN user:1 $
```

### RedisGraph
Graph database with Cypher queries.

```redis
# Create nodes and relationships
GRAPH.QUERY social "CREATE (:Person {name:'Alice', age:30})"
GRAPH.QUERY social "CREATE (:Person {name:'Bob', age:25})"
GRAPH.QUERY social "MATCH (a:Person {name:'Alice'}), (b:Person {name:'Bob'})
                     CREATE (a)-[:FRIEND]->(b)"

# Query
GRAPH.QUERY social "MATCH (p:Person)-[:FRIEND]->(f) RETURN p.name, f.name"

# Shortest path
GRAPH.QUERY social "MATCH p=shortestPath((a:Person {name:'Alice'})-[*]-(b:Person {name:'Charlie'}))
                     RETURN p"
```

### RedisTimeSeries
Time-series data storage.

```redis
# Create time-series
TS.CREATE temperature:sensor1 RETENTION 86400000 LABELS sensor_id 1 type temperature

# Add samples
TS.ADD temperature:sensor1 * 23.5
TS.ADD temperature:sensor1 * 24.1

# Query
TS.RANGE temperature:sensor1 - +
TS.RANGE temperature:sensor1 1609459200000 1609545600000

# Aggregations
TS.RANGE temperature:sensor1 - + AGGREGATION avg 3600000

# Multi-series query
TS.MRANGE - + FILTER type=temperature
```

### RedisBloom
Probabilistic data structures.

```redis
# Bloom filter
BF.ADD bloom:users "user1"
BF.EXISTS bloom:users "user1"  # Returns: 1
BF.EXISTS bloom:users "user999"  # Returns: 0 (probably)

# Cuckoo filter
CF.ADD cuckoo:users "user1"
CF.DEL cuckoo:users "user1"  # Can delete (unlike Bloom)

# Count-Min Sketch
CMS.INCRBY cms:pageviews page1 1
CMS.QUERY cms:pageviews page1

# Top-K
TOPK.ADD topk:products product1 product2 product1
TOPK.LIST topk:products
```

## Production Best Practices

### Deployment Architecture

#### Standalone
```
[Application] --> [Redis Master]
```
Simple, no HA.

#### Master-Replica
```
[Application] --> [Redis Master] --> [Redis Replica 1]
                                  --> [Redis Replica 2]
```
Read scaling, basic HA with manual failover.

#### Sentinel
```
[Application] --> [Sentinel 1] --> [Redis Master] --> [Replica 1]
              --> [Sentinel 2]                     --> [Replica 2]
              --> [Sentinel 3]
```
Automatic failover, HA.

#### Cluster
```
[Application] --> [Cluster Proxy/Client]
                       |
    +------------------+------------------+
    |                  |                  |
[Master 1]        [Master 2]        [Master 3]
[Replica 1]       [Replica 2]       [Replica 3]
```
Horizontal scaling, sharding, HA.

### Configuration Checklist

```conf
# Performance
tcp-backlog 511
timeout 0
tcp-keepalive 300
maxclients 10000

# Memory
maxmemory 2gb
maxmemory-policy allkeys-lru
maxmemory-samples 5

# Persistence (choose based on needs)
save 900 1
save 300 10
save 60 10000
appendonly yes
appendfsync everysec

# Replication
repl-diskless-sync yes
repl-backlog-size 100mb

# Security
requirepass strong_password_here
rename-command FLUSHDB ""
rename-command FLUSHALL ""
bind 127.0.0.1 192.168.1.100

# Slow log
slowlog-log-slower-than 10000
slowlog-max-len 128

# Client output buffer limits
client-output-buffer-limit normal 0 0 0
client-output-buffer-limit replica 256mb 64mb 60
client-output-buffer-limit pubsub 32mb 8mb 60
```

### Monitoring Metrics

**Critical Metrics**:
- `used_memory` / `maxmemory`: Memory usage
- `mem_fragmentation_ratio`: Should be ~1.0-1.5
- `instantaneous_ops_per_sec`: Operations per second
- `connected_clients`: Client connections
- `blocked_clients`: Clients waiting on blocking ops
- `evicted_keys`: Keys evicted due to memory
- `keyspace_hits` / `keyspace_misses`: Cache hit ratio
- `rejected_connections`: Connection limit reached
- `master_link_down_since_seconds`: Replication lag

**Health Check Script**:
```bash
#!/bin/bash
redis-cli PING | grep -q PONG || exit 1
redis-cli INFO replication | grep -q "master_link_status:up" || exit 1
```

### Backup Strategy

```bash
# Automated backup script
#!/bin/bash
DATE=$(date +%Y%m%d_%H%M%S)
BACKUP_DIR="/backups/redis"

# Trigger BGSAVE
redis-cli BGSAVE

# Wait for save to complete
while [ $(redis-cli LASTSAVE) -eq $LAST_SAVE ]; do
    sleep 1
done

# Copy RDB file
cp /var/lib/redis/dump.rdb $BACKUP_DIR/dump_$DATE.rdb

# Compress
gzip $BACKUP_DIR/dump_$DATE.rdb

# Retain last 7 days
find $BACKUP_DIR -name "dump_*.rdb.gz" -mtime +7 -delete
```

### Disaster Recovery

**RDB Recovery**:
```bash
# Stop Redis
systemctl stop redis

# Replace dump.rdb
cp /backup/dump.rdb /var/lib/redis/dump.rdb
chown redis:redis /var/lib/redis/dump.rdb

# Start Redis
systemctl start redis
```

**AOF Recovery**:
```bash
# Check AOF integrity
redis-check-aof /var/lib/redis/appendonly.aof

# Fix if corrupted
redis-check-aof --fix /var/lib/redis/appendonly.aof

# Start Redis
systemctl start redis
```

### Capacity Planning

**Memory Formula**:
```
Total Memory = Dataset Size × (1 + Overhead)

Where Overhead = 30-40% for:
- Internal data structures
- Fragmentation
- Replication buffer
- Client buffers
```

**Example**:
- Dataset: 10GB
- Overhead: 40%
- Total: 10GB × 1.4 = 14GB
- Recommended: 16GB RAM

### Connection Pooling

```python
# Good practice
import redis

pool = redis.ConnectionPool(
    host='localhost',
    port=6379,
    max_connections=50,
    socket_timeout=5,
    socket_connect_timeout=5,
    retry_on_timeout=True,
    health_check_interval=30
)

redis_client = redis.Redis(connection_pool=pool)
```

### Error Handling

```python
import redis
from redis.exceptions import (
    ConnectionError,
    TimeoutError,
    ResponseError
)

def safe_redis_operation():
    try:
        result = redis_client.get('key')
        return result
    except ConnectionError:
        # Handle connection failure
        logger.error("Redis connection failed")
        return None
    except TimeoutError:
        # Handle timeout
        logger.error("Redis operation timed out")
        return None
    except ResponseError as e:
        # Handle Redis errors (wrong type, etc.)
        logger.error(f"Redis error: {e}")
        return None
    except Exception as e:
        # Catch-all
        logger.error(f"Unexpected error: {e}")
        return None
```

### Testing Strategies

**Unit Tests**:
```python
import fakeredis
import unittest

class TestRedisOperations(unittest.TestCase):
    def setUp(self):
        self.redis = fakeredis.FakeRedis()

    def test_set_get(self):
        self.redis.set('key', 'value')
        self.assertEqual(self.redis.get('key'), b'value')

    def test_expiration(self):
        self.redis.setex('key', 1, 'value')
        time.sleep(2)
        self.assertIsNone(self.redis.get('key'))
```

**Load Testing**:
```bash
# Basic load test
redis-benchmark -h localhost -p 6379 -c 50 -n 100000

# Specific commands
redis-benchmark -t set,get -n 1000000 -q

# Pipeline test
redis-benchmark -n 1000000 -q -P 16
```

### Migration Strategies

#### Online Migration (MIGRATE command)
```redis
MIGRATE target_host target_port key 0 5000 COPY REPLACE
```

#### Bulk Migration
```bash
# Using redis-cli with --pipe
cat data.txt | redis-cli --pipe

# Using RIOT (Redis Input/Output Tools)
riot-file import data.csv --header \
  redis://target:6379 \
  --keyspace user --keys id
```

#### Replication-Based Migration
```conf
# On new Redis instance
replicaof old_redis_host old_redis_port

# After sync complete
replicaof no one
```

### Common Pitfalls

**Using KEYS command in production**
- Problem: `KEYS *` blocks Redis while scanning all keys, freezing the server
- Solution: Use `SCAN 0 MATCH pattern* COUNT 100` to iterate keys incrementally

**Fetching large hashes/sets at once**
- Problem: `HGETALL huge_hash` loads everything into memory, may cause timeouts
- Solution: Use `HSCAN huge_hash 0 COUNT 100` to process in chunks

**Forgetting to set expiration on keys**
- Problem: Keys without TTL accumulate and cause memory leaks
- Solution: Always set expiration: `SETEX session:123 3600 data` or `EXPIRE key 3600`

**Using DEL on large keys in transactions**
- Problem: `DEL large_key` blocks Redis during deletion
- Solution: Use `UNLINK large_key` for asynchronous, non-blocking deletion

**Not using connection pooling**
- Problem: Creating new connections for each operation is slow and wasteful
- Solution: Use connection pools: `pool = redis.ConnectionPool()` then `redis.Redis(connection_pool=pool)`

### Scaling Strategies

**Vertical Scaling** (Scale Up):
- Increase RAM
- Faster CPU
- Better network
- Limit: Single machine capacity

**Horizontal Scaling** (Scale Out):
- Redis Cluster (sharding)
- Multiple read replicas
- Client-side sharding
- Proxy-based sharding (Twemproxy, Envoy)

**Functional Partitioning**:
```
Redis 1: Sessions
Redis 2: Caching
Redis 3: Analytics
Redis 4: Job queues
```

## Summary: Quick Reference

### When to Use What

| Use Case | Data Structure |
|----------|----------------|
| Counter | String (INCR) |
| Object storage | Hash |
| Queue | List (LPUSH/RPOP) |
| Unique items | Set |
| Ranking/Leaderboard | Sorted Set |
| Time-series | Sorted Set or Stream |
| Pub/Sub messaging | Pub/Sub or Stream |
| Location data | Geospatial |
| Unique counting | HyperLogLog |
| Flags/bits | Bitmap |

### Performance Tips

1. Use pipelining for bulk operations
2. Enable lazy freeing (UNLINK vs DEL)
3. Use appropriate data structures
4. Set expiration on all keys
5. Use connection pooling
6. Monitor memory fragmentation
7. Use SCAN instead of KEYS
8. Optimize ziplist thresholds
9. Use Lua scripts for complex atomicity
10. Enable AOF rewrite for smaller files

### Production Checklist

- [ ] Set maxmemory and eviction policy
- [ ] Configure persistence (RDB/AOF)
- [ ] Enable authentication (requirepass/ACL)
- [ ] Bind to specific interfaces
- [ ] Set up monitoring and alerting
- [ ] Configure slow log
- [ ] Set up backups
- [ ] Test disaster recovery
- [ ] Document runbooks
- [ ] Load test before production
- [ ] Set up HA (Sentinel/Cluster)
- [ ] Configure client timeouts
- [ ] Enable lazy freeing
- [ ] Rename dangerous commands

---

**Previous:** [← Redis Guide - Part 2 (Intermediate)](./redis-intermediate)
