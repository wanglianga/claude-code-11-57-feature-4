import { useEffect, useState } from 'react';
import {
  getAnnotation, onAnnotationRemoteChange, saveAnnotationFields, type FieldMergeConflict,
} from '../db';
import { nowISO } from '../lib/time';
import type { Annotation } from '../types';

const FIELDS = ['处置理由', '风险结论', '复核意见'];

/**
 * 字段级批注：两个页面并发修改处置理由时，按字段合并保留差异；
 * 同字段冲突以 updatedAt 较新者胜并留痕，不做整单最后保存覆盖。
 */
export default function AnnotationPanel({
  subjectType, subjectId, title,
}: {
  subjectType: Annotation['subjectType'];
  subjectId: string;
  title: string;
}) {
  const [annotation, setAnnotation] = useState<Annotation | undefined>(undefined);
  const [author, setAuthor] = useState('值班员甲');
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [conflicts, setConflicts] = useState<FieldMergeConflict[]>([]);
  const [savedAt, setSavedAt] = useState('');

  const load = async () => setAnnotation(await getAnnotation(subjectType, subjectId));
  useEffect(() => {
    void load();
    const off = onAnnotationRemoteChange(() => void load());
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subjectType, subjectId]);

  const save = async () => {
    const at = nowISO();
    const incoming: Annotation['fields'] = {};
    for (const [field, value] of Object.entries(drafts)) {
      if (value.trim()) incoming[field] = { field, author, value: value.trim(), updatedAt: at };
    }
    if (Object.keys(incoming).length === 0) return;
    const res = await saveAnnotationFields(subjectType, subjectId, incoming, at);
    setAnnotation(res.annotation);
    setConflicts(res.conflicts);
    setSavedAt(at);
    setDrafts({});
  };

  return (
    <div className="card">
      <h2>{title}</h2>
      <div className="form-row">
        <label className="field">批注作者（模拟不同页面/值班员）
          <select value={author} onChange={(e) => setAuthor(e.target.value)}>
            <option>值班员甲</option><option>值班员乙</option><option>防办值班长</option>
          </select>
        </label>
      </div>
      {FIELDS.map((field) => {
        const saved = annotation?.fields[field];
        return (
          <div key={field} style={{ borderBottom: '1px solid var(--border)', paddingBottom: 8, marginBottom: 8 }}>
            <div className="small muted">{field}{saved ? `（${saved.author} @ ${saved.updatedAt.slice(11, 19)}）` : '（尚无批注）'}</div>
            <div className="small" style={{ margin: '4px 0' }}>已存：{saved?.value ?? '—'}</div>
            <input
              placeholder={`填写${field}（保存时按字段合并，不覆盖其他字段）`}
              value={drafts[field] ?? ''}
              onChange={(e) => setDrafts((d) => ({ ...d, [field]: e.target.value }))}
            />
          </div>
        );
      })}
      <button className="primary" onClick={() => void save()}>保存字段级批注</button>
      {savedAt && <span className="muted small" style={{ marginLeft: 10 }}>上次保存 {savedAt.slice(11, 19)}，修订版本 #{annotation?.revision}</span>}
      {conflicts.length > 0 && (
        <div className="banner warn mt8">
          检测到 {conflicts.length} 个同字段并发修改，已按时间较新者胜出，差异留痕：
          {conflicts.map((c) => (
            <div key={c.field} className="small mono">
              {c.field}：{c.existing.author}「{c.existing.value}」 vs {c.incoming.author}「{c.incoming.value}」
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
