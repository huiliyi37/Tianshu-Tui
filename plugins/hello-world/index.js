export const tools = [
  {
    definition: {
      name: 'hello',
      description: 'Echo a greeting — pipeline probe tool for plugin system validation',
      input_schema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Name to greet (default: World)' },
        },
      },
    },
    execute: async (params) => {
      const name = params?.name || 'World'
      return { content: `Hello, ${name}! 👋 Plugin system is working.` }
    },
    requiresApproval: () => false,
    isConcurrencySafe: () => true,
    isEnabled: () => true,
  },
]
