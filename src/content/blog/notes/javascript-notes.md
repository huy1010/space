---
title: JavaScript Notes
description: Something about JavaScript.
duration: 5min
date: 2025-10-21
---

## Pass-by-Reference vs Pass-by-Value

JavaScript is **pass-by-value**, but objects behave differently from primitives.

### Primitives (Pass-by-Value)

```javascript
function changeValue(x) {
  x = 10
}

const num = 5
changeValue(num)
console.log(num) // 5 (unchanged - copy of value)
```

### Objects (Pass-by-Value of Reference)

Objects are passed by "value of reference" - the reference is copied, not the object itself.

```javascript
// Modifying properties works
function modify(obj) {
  obj.name = 'Changed'
}

const person = { name: 'John' }
modify(person)
console.log(person.name) // 'Changed'

// Reassigning reference doesn't work
function reassign(obj) {
  obj = { name: 'New' }
}

const person2 = { name: 'John' }
reassign(person2)
console.log(person2.name) // 'John' (unchanged)
```

**Key point**: You can modify object/array properties, but cannot reassign the reference itself.

## Risks of Using JSON Serialization for Deep Cloning

Using `JSON.parse(JSON.stringify())` for deep cloning has significant limitations:

### Key Problems

```javascript
const obj = {
  name: 'John',
  age: undefined, // Lost
  greet() {}, // Lost
  createdAt: new Date(), // Becomes string
  pattern: /test/g, // Becomes {}
  tags: new Set(['js']), // Becomes {}
  [Symbol('id')]: 123 // Lost
}

const cloned = JSON.parse(JSON.stringify(obj))
// Functions, undefined, Symbols, Dates, RegExp, Map/Set are lost or corrupted
```

### Circular References Cause Errors

```javascript
const obj = { name: 'John' }
obj.self = obj // circular reference

JSON.parse(JSON.stringify(obj)) // TypeError: Converting circular structure to JSON
```

### Alternatives

- **Shallow clone**: `{ ...obj }` or `Object.assign({}, obj)`
- **Deep clone**: `structuredClone(obj)` (modern browsers) or `_.cloneDeep(obj)`

**Use JSON serialization only for simple objects with primitive values.**
