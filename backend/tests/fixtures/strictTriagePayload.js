// Build a complete synthetic transport response against the actual shared schema.
function sample(schema) {
  if (schema.enum) return schema.enum[0];
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  if (type === "object") return Object.fromEntries(Object.entries(schema.properties).map(([key, field]) => [key, sample(field)]));
  if (type === "array") return [];
  if (type === "string") return "";
  if (type === "boolean") return false;
  if (type === "integer") return schema.minimum || 1;
  return null;
}
module.exports = sample;
