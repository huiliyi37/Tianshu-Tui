const key = process.env.MIMO_API_KEY
if (!key) { console.log('MIMO_API_KEY not set'); process.exit(1) }
const base = 'https://token-plan-sgp.xiaomimimo.com/v1'

async function test(body: Record<string,unknown>, name: string) {
  const r = await fetch(base + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
    body: JSON.stringify(body),
  })
  const text = await r.text()
  console.log(`${name}: ${r.status} ${text.slice(0, 300)}`)
}

async function main() {
  // Test 1: minimal
  await test({ model: 'mimo-v2.5', messages: [{ role: 'user', content: 'hi' }], stream: false, max_tokens: 10 }, 'minimal')
  // Test 2: with thinking
  await test({ model: 'mimo-v2.5', messages: [{ role: 'user', content: 'hi' }], stream: false, max_tokens: 10, thinking: { type: 'enabled' } }, 'thinking')
  // Test 3: with stream_options
  await test({ model: 'mimo-v2.5', messages: [{ role: 'user', content: 'hi' }], stream: false, max_tokens: 10, stream_options: { include_usage: true } }, 'stream_opts')
  // Test 4: streaming minimal
  await test({ model: 'mimo-v2.5', messages: [{ role: 'user', content: 'hi' }], stream: true, max_tokens: 10 }, 'stream_minimal')
}

main()
