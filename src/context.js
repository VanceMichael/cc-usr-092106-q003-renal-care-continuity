// 读取并检查项目共享的领域资料。
export function parseContext(raw) {
  const value = JSON.parse(raw);
  if (!value.domain || !value.version || !value.sample_id || !Array.isArray(value.facts) || value.facts.length === 0) {
    throw new Error('领域资料缺少必要字段');
  }
  return value;
}
