import Busboy from "busboy";

function rawBuffer(req) {
  if (Buffer.isBuffer(req.rawBody)) return req.rawBody;
  if (Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === "string") return Buffer.from(req.body);
  return Buffer.from("");
}

function formDataLike(entries) {
  return {
    get(name) {
      return entries.get(name);
    },
    keys() {
      return entries.keys();
    },
  };
}

export async function readJson(req) {
  if (req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body)) return req.body;
  const raw = rawBuffer(req).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

export async function readFormData(req) {
  const contentType = req.get("content-type") || "";

  if (contentType.includes("application/x-www-form-urlencoded")) {
    const params = new URLSearchParams(rawBuffer(req).toString("utf8"));
    return formDataLike(params);
  }

  if (!contentType.includes("multipart/form-data")) {
    return formDataLike(new Map());
  }

  return new Promise((resolve, reject) => {
    const fields = new Map();
    const busboy = Busboy({ headers: req.headers });
    busboy.on("field", (name, value) => fields.set(name, value));
    busboy.on("error", reject);
    busboy.on("finish", () => resolve(formDataLike(fields)));
    busboy.end(rawBuffer(req));
  });
}
