// Incremental reader for the Plembfin backup document
// {format, version, ..., collections: {name: [document, ...]}, ...}.
// Text is fed in arbitrary pieces with write(); top-level fields are reported
// whole, and each collection document is reported on its own, so a backup of
// any size is read without ever holding it as one string (V8 strings stop at
// about 512 MB).

const START = 0;
const TOP_KEY = 1;
const TOP_KEY_REQUIRED = 2;
const TOP_COLON = 3;
const TOP_VALUE = 4;
const TOP_AFTER = 5;
const COLLECTIONS_OPEN = 6;
const COLLECTION_KEY = 7;
const COLLECTION_KEY_REQUIRED = 8;
const COLLECTION_COLON = 9;
const COLLECTION_ARRAY_OPEN = 10;
const DOCUMENT_FIRST = 11;
const DOCUMENT_NEXT = 12;
const DOCUMENT_AFTER = 13;
const COLLECTION_AFTER = 14;
const DONE = 15;

function isWhitespace(code) {
  return code === 32 || code === 10 || code === 13 || code === 9;
}

function malformed(detail) {
  return new Error(`The backup file is not valid JSON (${detail}).`);
}

export class BackupStreamScanner {
  constructor({ onField = () => {}, onCollectionStart = () => {}, onDocument = () => {}, onCollectionEnd = () => {}, wantsDocuments = () => true } = {}) {
    this.handlers = { onField, onCollectionStart, onDocument, onCollectionEnd, wantsDocuments };
    this.state = START;
    this.capture = null;
    this.key = "";
    this.collection = "";
    this.wanted = false;
  }

  write(text) {
    let index = 0;
    const length = text.length;
    while (index < length) {
      if (this.capture) {
        index = this.continueCapture(text, index);
        continue;
      }
      const code = text.charCodeAt(index);
      if (isWhitespace(code)) {
        index += 1;
        continue;
      }
      const char = text[index];
      switch (this.state) {
        case START:
          if (char !== "{") throw malformed("expected an object");
          this.state = TOP_KEY;
          index += 1;
          break;
        case TOP_KEY:
        case TOP_KEY_REQUIRED:
          if (char === "}" && this.state === TOP_KEY) {
            this.state = DONE;
            index += 1;
          } else if (char === "\"") {
            this.startCapture(index,(raw) => {
              this.key = JSON.parse(raw);
              this.state = TOP_COLON;
            });
          } else {
            throw malformed("expected a field name");
          }
          break;
        case TOP_COLON:
          if (char !== ":") throw malformed("expected ':'");
          this.state = this.key === "collections" ? COLLECTIONS_OPEN : TOP_VALUE;
          index += 1;
          break;
        case TOP_VALUE:
          this.startCapture(index,(raw) => {
            this.handlers.onField(this.key, JSON.parse(raw));
            this.state = TOP_AFTER;
          });
          break;
        case TOP_AFTER:
          if (char === ",") this.state = TOP_KEY_REQUIRED;
          else if (char === "}") this.state = DONE;
          else throw malformed("expected ',' or '}'");
          index += 1;
          break;
        case COLLECTIONS_OPEN:
          if (char !== "{") throw new Error("The backup does not contain a collections object.");
          this.state = COLLECTION_KEY;
          index += 1;
          break;
        case COLLECTION_KEY:
        case COLLECTION_KEY_REQUIRED:
          if (char === "}" && this.state === COLLECTION_KEY) {
            this.state = TOP_AFTER;
            index += 1;
          } else if (char === "\"") {
            this.startCapture(index,(raw) => {
              this.collection = JSON.parse(raw);
              this.state = COLLECTION_COLON;
            });
          } else {
            throw malformed("expected a collection name");
          }
          break;
        case COLLECTION_COLON:
          if (char !== ":") throw malformed("expected ':'");
          this.state = COLLECTION_ARRAY_OPEN;
          index += 1;
          break;
        case COLLECTION_ARRAY_OPEN:
          if (char !== "[") throw new Error(`${this.collection} is not a valid document array.`);
          this.wanted = Boolean(this.handlers.wantsDocuments(this.collection));
          this.handlers.onCollectionStart(this.collection);
          this.state = DOCUMENT_FIRST;
          index += 1;
          break;
        case DOCUMENT_FIRST:
        case DOCUMENT_NEXT:
          if (char === "]" && this.state === DOCUMENT_FIRST) {
            this.handlers.onCollectionEnd(this.collection);
            this.state = COLLECTION_AFTER;
            index += 1;
          } else {
            this.startCapture(index,(raw) => {
              if (this.wanted) this.handlers.onDocument(this.collection, JSON.parse(raw));
              this.state = DOCUMENT_AFTER;
            });
          }
          break;
        case DOCUMENT_AFTER:
          if (char === ",") {
            this.state = DOCUMENT_NEXT;
          } else if (char === "]") {
            this.handlers.onCollectionEnd(this.collection);
            this.state = COLLECTION_AFTER;
          } else {
            throw malformed("expected ',' or ']'");
          }
          index += 1;
          break;
        case COLLECTION_AFTER:
          if (char === ",") this.state = COLLECTION_KEY_REQUIRED;
          else if (char === "}") this.state = TOP_AFTER;
          else throw malformed("expected ',' or '}'");
          index += 1;
          break;
        case DONE:
          throw malformed("unexpected text after the end");
        default:
          throw malformed("unknown state");
      }
    }
  }

  end() {
    if (this.capture?.kind === "primitive") this.finishCapture("");
    if (this.capture || this.state !== DONE) throw malformed("the file ends early");
  }

  // Values are captured as raw text (joined across pieces) and parsed once
  // complete. Nested values track depth outside strings; primitives end at the
  // next delimiter, which is left for the state machine.
  startCapture(index, done) {
    this.capture = { parts: [], depth: 0, inString: false, escape: false, kind: "", start: index, done };
  }

  continueCapture(text, index) {
    const capture = this.capture;
    if (!capture.kind) {
      const char = text[index];
      capture.start = index;
      if (char === "{" || char === "[") {
        capture.kind = "nested";
      } else if (char === "\"") {
        capture.kind = "string";
        capture.inString = true;
        index += 1;
      } else {
        capture.kind = "primitive";
      }
    }
    const length = text.length;
    if (capture.kind === "primitive") {
      for (let at = index; at < length; at += 1) {
        const code = text.charCodeAt(at);
        // , } ] or whitespace end a number, true, false or null.
        if (code === 44 || code === 125 || code === 93 || isWhitespace(code)) {
          capture.parts.push(text.slice(capture.start, at));
          this.finishCapture("");
          return at;
        }
      }
      capture.parts.push(text.slice(capture.start));
      capture.start = 0;
      return length;
    }
    let { depth, inString, escape } = capture;
    for (let at = index; at < length; at += 1) {
      const code = text.charCodeAt(at);
      if (inString) {
        if (escape) escape = false;
        else if (code === 92) escape = true;
        else if (code === 34) {
          inString = false;
          if (capture.kind === "string") {
            capture.parts.push(text.slice(capture.start, at + 1));
            this.finishCapture("");
            return at + 1;
          }
        }
      } else if (code === 34) {
        inString = true;
      } else if (code === 123 || code === 91) {
        depth += 1;
      } else if (code === 125 || code === 93) {
        depth -= 1;
        if (depth === 0) {
          capture.parts.push(text.slice(capture.start, at + 1));
          this.finishCapture("");
          return at + 1;
        }
      }
    }
    capture.parts.push(text.slice(capture.start));
    capture.start = 0;
    Object.assign(capture, { depth, inString, escape });
    return length;
  }

  finishCapture(extra) {
    const capture = this.capture;
    this.capture = null;
    const raw = capture.parts.join("") + extra;
    try {
      capture.done(raw);
    } catch (error) {
      if (error instanceof SyntaxError) throw malformed(error.message);
      throw error;
    }
  }
}
