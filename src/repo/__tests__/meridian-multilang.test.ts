import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseFile, parsePythonFile, parseGoFile, detectLang } from '../meridian-parser.js'

describe('detectLang', () => {
  it('detects TypeScript', () => assert.equal(detectLang('src/foo.ts'), 'typescript'))
  it('detects TSX', () => assert.equal(detectLang('src/foo.tsx'), 'typescript'))
  it('detects Python', () => assert.equal(detectLang('src/foo.py'), 'python'))
  it('detects Go', () => assert.equal(detectLang('src/foo.go'), 'go'))
  it('returns null for unknown', () => assert.equal(detectLang('src/foo.rs'), null))
})

describe('parsePythonFile', () => {
  it('extracts functions and classes', async () => {
    const source = `
def hello(name: str) -> str:
    return f"Hello {name}"

class UserService:
    def get_user(self, id: int):
        pass

def _private():
    pass
`
    const result = await parsePythonFile('app.py', source)
    const names = result.symbols.map(s => s.name)
    assert.ok(names.includes('hello'))
    assert.ok(names.includes('UserService'))
    assert.ok(names.includes('get_user'))
    assert.ok(names.includes('_private'))

    const hello = result.symbols.find(s => s.name === 'hello')!
    assert.equal(hello.kind, 'function')
    assert.equal(hello.exported, true) // top-level = exported

    const getUser = result.symbols.find(s => s.name === 'get_user')!
    assert.equal(getUser.kind, 'function')
    assert.equal(getUser.exported, false) // nested in class

    const cls = result.symbols.find(s => s.name === 'UserService')!
    assert.equal(cls.kind, 'class')
  })

  it('extracts imports', async () => {
    const source = `
import os
from pathlib import Path
from .utils import helper
from ..core import base
`
    const result = await parsePythonFile('app.py', source)
    assert.ok(result.imports.includes('os'))
    assert.ok(result.imports.includes('pathlib'))
    assert.ok(result.imports.includes('.utils'))
    assert.ok(result.imports.includes('..core'))
  })

  it('builds contains edges for nested defs', async () => {
    const source = `
class Foo:
    def bar(self):
        pass
`
    const result = await parsePythonFile('app.py', source)
    const containsEdge = result.edges.find(e => e.kind === 'contains')
    assert.ok(containsEdge)
    assert.ok(containsEdge.sourceId.includes('Foo'))
    assert.ok(containsEdge.targetId.includes('bar'))
  })
})

describe('parseGoFile', () => {
  it('extracts functions and types', async () => {
    const source = `
package main

func Hello(name string) string {
    return "Hello " + name
}

func privateFunc() {}

type UserService struct {
    db *sql.DB
}

type Reader interface {
    Read(p []byte) (n int, err error)
}
`
    const result = await parseGoFile('main.go', source)
    const names = result.symbols.map(s => s.name)
    assert.ok(names.includes('Hello'))
    assert.ok(names.includes('privateFunc'))
    assert.ok(names.includes('UserService'))
    assert.ok(names.includes('Reader'))

    const hello = result.symbols.find(s => s.name === 'Hello')!
    assert.equal(hello.kind, 'function')
    assert.equal(hello.exported, true) // uppercase = exported

    const priv = result.symbols.find(s => s.name === 'privateFunc')!
    assert.equal(priv.exported, false) // lowercase = unexported

    const svc = result.symbols.find(s => s.name === 'UserService')!
    assert.equal(svc.kind, 'type')

    const reader = result.symbols.find(s => s.name === 'Reader')!
    assert.equal(reader.kind, 'interface')
  })

  it('extracts imports', async () => {
    const source = `
package main

import (
    "fmt"
    "os"
    "github.com/user/pkg"
)
`
    const result = await parseGoFile('main.go', source)
    assert.ok(result.imports.includes('fmt'))
    assert.ok(result.imports.includes('os'))
    assert.ok(result.imports.includes('github.com/user/pkg'))
  })

  it('extracts method declarations', async () => {
    const source = `
package main

func (s *Server) Start() error {
    return nil
}
`
    const result = await parseGoFile('server.go', source)
    const start = result.symbols.find(s => s.name === 'Start')
    assert.ok(start)
    assert.equal(start.kind, 'method')
    assert.equal(start.exported, true)
  })
})

describe('parseFile dispatcher', () => {
  it('routes .py to Python parser', async () => {
    const result = await parseFile('app.py', 'def foo(): pass')
    assert.ok(result.symbols.some(s => s.name === 'foo'))
  })

  it('routes .go to Go parser', async () => {
    const result = await parseFile('main.go', 'package main\nfunc Foo() {}')
    assert.ok(result.symbols.some(s => s.name === 'Foo'))
  })

  it('routes .ts to TypeScript parser', async () => {
    const result = await parseFile('app.ts', 'export function bar() {}')
    assert.ok(result.symbols.some(s => s.name === 'bar'))
  })

  it('throws for unsupported extension', async () => {
    await assert.rejects(() => parseFile('app.rs', 'fn main() {}'), /Unsupported language/)
  })
})
