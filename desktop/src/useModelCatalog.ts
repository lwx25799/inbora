import {useEffect, useState} from 'react';
import type {PublicModelConnection} from '../../src/contracts/model-providers.js';
import {readModelCatalog} from './api';
import {explainSafe} from './error-messages';

const emptyModels: PublicModelConnection['models'] = [];

export function useModelCatalog(connection?: PublicModelConnection) {
  const key = connection?.modelsTruncated ? `${connection.id}:${connection.version}` : null;
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{key: string; attempt: number; models?: PublicModelConnection['models']; error?: string}>();
  useEffect(() => {
    if (!key || !connection) return;
    let active = true;
    void readModelCatalog(connection).then(models => {
      if (active) setResult({key, attempt, models});
    }).catch(error => {
      if (active) setResult({key, attempt, error: explainSafe(error, '无法读取完整模型目录。')});
    });
    return () => { active = false; };
  }, [key, attempt]);
  const current = result?.key === key && result.attempt === attempt ? result : undefined;
  return {
    models: current?.models ?? connection?.models ?? emptyModels,
    complete: !key || !!current?.models,
    error: current?.error,
    retry: () => setAttempt(value => value + 1),
  };
}
