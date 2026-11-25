import fs from 'fs';
import os from 'os';
import path from 'path';
import { AiMemoryService } from '../../src/modules/assistant/ai-memory.service';

describe('AI memory tenant isolation', () => {
  it('does not learn store-specific answers into the global memory', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stockpilot-ai-memory-'));
    const filePath = path.join(dir, 'knowledge.json');
    fs.writeFileSync(filePath, '[]', 'utf8');

    const memory = new AiMemoryService(filePath);
    await expect(memory.learn('hướng dẫn nhập kho', 'Câu trả lời theo dữ liệu riêng của cửa hàng A.')).resolves.toBeNull();
  });

  it('does not rewrite the knowledge file while skipping old learned entries', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stockpilot-ai-memory-'));
    const filePath = path.join(dir, 'knowledge.json');
    const original = JSON.stringify([
      { id: 'learned-old', question: 'Câu hỏi cũ', answer: 'Dữ liệu cũ theo cửa hàng', category: 'general' },
    ]);
    fs.writeFileSync(filePath, original, 'utf8');

    new AiMemoryService(filePath);

    expect(fs.readFileSync(filePath, 'utf8')).toBe(original);
  });
});
