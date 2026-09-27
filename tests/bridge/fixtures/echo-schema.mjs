// Deliberately unusual schema: the bridge must pass it through untouched.
export const ECHO_SCHEMA = {
  type: 'object',
  properties: { text: { type: 'string', minLength: 1, description: 'text to echo' } },
  required: ['text'],
  additionalProperties: false,
};
