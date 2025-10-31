// Utility method for defineModel
export function modelDataToJSON() {
  // Remove helpText and comment from fields
  const normalizedFields = this.fields;
  const filteredFields = Object.fromEntries(
    Object.entries(normalizedFields).map(([key, field]) => {
      const { helpText, comment, ...rest } = field;
      return [key, typeof field.toJSON === "function" ? field.toJSON() : rest];
    })
  );

  // Remove comment from meta
  const filteredMeta = (() => {
    if (!this.meta) return {};
    const { comment, helpText, ...restMeta } = this.meta;
    return restMeta;
  })();

  return {
    name: this.name,
    fields: filteredFields,
    relations: this.relations,
    triggers: this.triggers,
    meta: filteredMeta,
    //methods are excluded
  };
}
