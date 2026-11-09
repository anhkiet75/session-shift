export function required<T>(value: T): NonNullable<T> {
  if (value === null || value === undefined) throw new Error('Expected a value in this test scenario');
  return value;
}
