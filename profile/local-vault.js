/**
 * Privamon — Local Vault (Interface Only)
 *
 * Architecture stub for user profile data that stays client-side.
 * In the future, the server can reference vault keys (e.g., "local.email")
 * and the client resolves them locally, without revealing actual values.
 *
 * Phase 1: Interface only. No data pre-populated.
 * Phase 2: Will add UI for vault management and server-side reference resolution.
 */
var Privamon = Privamon || {};

Privamon.LocalVault = class LocalVault {
  /**
   * Supported vault field schema.
   */
  static SCHEMA = {
    name: { label: 'Full Name', sensitive: true },
    firstName: { label: 'First Name', sensitive: true },
    lastName: { label: 'Last Name', sensitive: true },
    email: { label: 'Email Address', sensitive: true },
    phone: { label: 'Phone Number', sensitive: true },
    address: { label: 'Address', sensitive: true },
    city: { label: 'City', sensitive: false },
    state: { label: 'State', sensitive: false },
    zip: { label: 'ZIP / Postal Code', sensitive: true },
    dob: { label: 'Date of Birth', sensitive: true },
    aadhaar: { label: 'Aadhaar Number', sensitive: true },
    pan: { label: 'PAN Number', sensitive: true },
    cardNumber: { label: 'Card Number', sensitive: true },
    cardExpiry: { label: 'Card Expiry', sensitive: true },
    cardCvv: { label: 'Card CVV', sensitive: true },
  };

  constructor() {
    this._loaded = false;
    this._store = {};
  }

  /**
   * Load vault data from chrome.storage.local.
   */
  async load() {
    try {
      const result = await chrome.storage.local.get('privamon_vault');
      this._store = result.privamon_vault || {};
      this._loaded = true;
    } catch (err) {
      console.warn('[LocalVault] Failed to load:', err);
      this._store = {};
    }
  }

  /**
   * Save vault data to chrome.storage.local.
   */
  async save() {
    try {
      await chrome.storage.local.set({ privamon_vault: this._store });
    } catch (err) {
      console.error('[LocalVault] Failed to save:', err);
    }
  }

  /**
   * Set a vault field.
   * @param {string} key - Field key (must be in SCHEMA)
   * @param {string} value - Field value
   */
  async set(key, value) {
    if (!(key in LocalVault.SCHEMA)) {
      throw new Error(`Unknown vault field: ${key}`);
    }
    this._store[key] = value;
    await this.save();
  }

  /**
   * Get a vault field value.
   * @param {string} key
   * @returns {string|null}
   */
  async get(key) {
    if (!this._loaded) await this.load();
    return this._store[key] || null;
  }

  /**
   * Resolve a reference like "local.email" to its actual value.
   * Used by the future action executor.
   * @param {string} reference - e.g., "local.email"
   * @returns {string|null}
   */
  async resolve(reference) {
    if (!reference || !reference.startsWith('local.')) return null;
    const key = reference.slice(6); // Remove "local." prefix
    return this.get(key);
  }

  /**
   * Get the schema (field names + labels) without values.
   * Safe to send to a server.
   * @returns {Object}
   */
  getSchema() {
    return { ...LocalVault.SCHEMA };
  }

  /**
   * Get which fields are currently populated (keys only, no values).
   * Safe to send to a server.
   * @returns {string[]}
   */
  async getPopulatedFields() {
    if (!this._loaded) await this.load();
    return Object.keys(this._store).filter(k => this._store[k]);
  }

  /**
   * Clear all vault data.
   */
  async clear() {
    this._store = {};
    await save();
  }
};
