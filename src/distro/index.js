const {
  defineModel,
  IntegerField,
  DecimalField,
  FloatingPointField,
  CharField,
  TextField,
  EnumField,
  DateField,
  DateTimeField,
  BlobField,
  BooleanField,
  UUIDField,
  JsonField,
  XmlField,
} = require("../models/definition");

const Fields = {
  IntegerField,
  DecimalField,
  FloatingPointField,
  CharField,
  TextField,
  EnumField,
  DateField,
  DateTimeField,
  BlobField,
  BooleanField,
  UUIDField,
  JsonField,
  XmlField,
};

module.exports = {
  defineModel,
  Fields,
};
