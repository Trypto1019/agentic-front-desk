"""A deliberately small JSON-Schema validator (the subset zod exports for tool args).

Supports: type (object/string/number/integer/boolean/array), properties,
required, additionalProperties: false, enum, pattern, minLength, maxLength.
Kept dependency-free so the harness runs on the Python standard library.
"""

import re

TYPES = {
    "object": dict,
    "string": str,
    "number": (int, float),
    "integer": int,
    "boolean": bool,
    "array": list,
}


def validate(value, schema, path="$"):
    """Return a list of error strings (empty means valid)."""
    errors = []
    expected = schema.get("type")
    if expected:
        py = TYPES.get(expected)
        if py is None or not isinstance(value, py) or (expected in ("number", "integer") and isinstance(value, bool)):
            return [f"{path}: expected {expected}"]
    if "enum" in schema and value not in schema["enum"]:
        errors.append(f"{path}: {value!r} not in {schema['enum']}")
    if isinstance(value, str):
        if "pattern" in schema and not re.search(schema["pattern"], value):
            errors.append(f"{path}: {value!r} does not match {schema['pattern']}")
        if "minLength" in schema and len(value) < schema["minLength"]:
            errors.append(f"{path}: shorter than {schema['minLength']}")
        if "maxLength" in schema and len(value) > schema["maxLength"]:
            errors.append(f"{path}: longer than {schema['maxLength']}")
    if isinstance(value, dict):
        props = schema.get("properties", {})
        for key in schema.get("required", []):
            # zod marks defaulted fields as required in its output schema; a default makes them optional on input.
            if key not in value and "default" not in props.get(key, {}):
                errors.append(f"{path}.{key}: required")
        if schema.get("additionalProperties") is False:
            for key in value:
                if key not in props:
                    errors.append(f"{path}.{key}: not allowed")
        for key, sub in props.items():
            if key in value:
                errors.extend(validate(value[key], sub, f"{path}.{key}"))
    return errors
