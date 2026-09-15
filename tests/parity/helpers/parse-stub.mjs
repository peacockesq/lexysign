export function createParseStub({ records = {} } = {}) {
  class ParseError extends Error {
    constructor(code, message) {
      super(message);
      this.code = code;
      this.name = "ParseError";
    }
  }
  Object.assign(ParseError, {
    SCRIPT_FAILED: 141,
    INVALID_SESSION_TOKEN: 209,
    OBJECT_NOT_FOUND: 101,
    OPERATION_FORBIDDEN: 119,
    SESSION_MISSING: 209,
    VALIDATION_ERROR: 142,
    INVALID_QUERY: 102
  });

  class ParseObject {
    constructor(className, attrs = {}) {
      this.className = className;
      this.id = attrs.id || attrs.objectId || null;
      this._attrs = { ...attrs };
    }
    get(key) {
      return this._attrs[key];
    }
    set(key, value) {
      this._attrs[key] = value;
    }
    increment(key, amount = 1) {
      this._attrs[key] = (this._attrs[key] || 0) + amount;
    }
    toJSON() {
      return { objectId: this.id, ...this._attrs };
    }
    async save() {
      if (!this.id) this.id = `obj_${this.className}_${Math.random().toString(16).slice(2)}`;
      const list = records[this.className] || (records[this.className] = []);
      const existing = list.find((row) => row.id === this.id);
      if (!existing) list.push(this);
      return this;
    }
  }

  class ParseQuery {
    constructor(className) {
      this.className = className;
      this._eq = {};
      this._neq = {};
    }
    equalTo(key, value) {
      this._eq[key] = value;
      return this;
    }
    notEqualTo(key, value) {
      this._neq[key] = value;
      return this;
    }
    include() {
      return this;
    }
    matches(row) {
      const actualOf = (key) => (row.get ? row.get(key) : row[key]);
      const eqOk = Object.entries(this._eq).every(([key, value]) => {
        const actual = actualOf(key);
        if (value && typeof value === "object" && value.objectId) {
          return actual?.objectId === value.objectId || actual?.id === value.objectId;
        }
        return actual === value;
      });
      if (!eqOk) return false;
      return Object.entries(this._neq).every(([key, value]) => actualOf(key) !== value);
    }
    async first() {
      const list = records[this.className] || [];
      return list.find((row) => this.matches(row)) || null;
    }
    async get(id) {
      const list = records[this.className] || [];
      const found = list.find((row) => row.id === id || row.objectId === id);
      if (!found || !this.matches(found)) {
        throw new ParseError(ParseError.OBJECT_NOT_FOUND, "Document not found.");
      }
      return found;
    }
  }

  return {
    Error: ParseError,
    Object: ParseObject,
    Query: ParseQuery,
    records
  };
}

export function createDocumentRecord(attrs) {
  const Parse = createParseStub();
  const doc = new Parse.Object("contracts_Document", attrs);
  doc.id = attrs.objectId || attrs.id;
  return doc;
}
