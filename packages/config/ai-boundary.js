/** The assistant may use domain stores and the AI SDK, never OS/code execution APIs. */
export const aiBoundaryConfig = {
  files: ['apps/backend/src/ai/**/*.ts'],
  rules: {
    'no-eval': 'error',
    'no-new-func': 'error',
    'no-implied-eval': 'error',
    'no-restricted-imports': [
      'error',
      {
        paths: [
          'node:child_process',
          'child_process',
          'node:fs',
          'fs',
          'node:vm',
          'vm',
          'node:module',
          'module',
          'node:worker_threads',
          'worker_threads',
          'node:http',
          'http',
          'node:https',
          'https',
          'node:net',
          'net',
          'node:tls',
          'tls',
        ].map((name) => ({
          name,
          message:
            'Assistant capabilities cannot access OS commands, application files or arbitrary network clients. Use the reviewed CRM stores and AI SDK.',
        })),
        patterns: [
          {
            group: ['node:fs/*', 'fs/*'],
            message:
              'Assistant capabilities cannot access OS commands, application files or arbitrary network clients. Use the reviewed CRM stores and AI SDK.',
          },
        ],
      },
    ],
    'no-restricted-globals': [
      'error',
      {
        name: 'fetch',
        message:
          'No arbitrary HTTP capability in assistant modules; use the AI SDK or a reviewed domain store.',
      },
    ],
    'no-restricted-syntax': [
      'error',
      {
        selector: 'ImportExpression',
        message: 'Assistant capability imports must be static and reviewable.',
      },
    ],
  },
};
