// The browser-only demo never calls a live model: API keys cannot be kept
// secret in a static page.
export default class Anthropic {
  constructor() { throw new Error('Live model is not available in the browser-only demo.') }
}
