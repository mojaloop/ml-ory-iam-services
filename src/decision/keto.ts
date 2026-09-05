import { config } from './config';

export interface SubjectSet {
  namespace: string;
  object: string;
  relation: string;
}

export interface Tuple {
  namespace: string;
  object: string;
  relation: string;
  subject_id?: string;
  subject_set?: SubjectSet;
}

interface CheckResponse {
  allowed: boolean;
}

interface QueryResponse {
  relation_tuples?: Tuple[];
  next_page_token?: string;
}

const url = (path: string, params: Record<string, string>): string => {
  const query = new URLSearchParams(params);
  return `${config.ketoReadUrl}${path}?${query.toString()}`;
};

/** Keto answers a denial with 403 and carries the verdict in the body either way. */
export async function check(
  namespace: string,
  object: string,
  relation: string,
  subjectId: string,
): Promise<boolean> {
  const response = await fetch(url('/relation-tuples/check', { namespace, object, relation, subject_id: subjectId }));
  if (response.status !== 200 && response.status !== 403) {
    throw new Error(`Keto check answered ${response.status}`);
  }
  const body = (await response.json()) as CheckResponse;
  return body.allowed === true;
}

/** Every tuple matching the filter, following Keto's pagination to the end. */
export async function query(params: Record<string, string>): Promise<Tuple[]> {
  const tuples: Tuple[] = [];
  let pageToken = '';
  do {
    const page = pageToken ? { ...params, page_token: pageToken } : params;
    const response = await fetch(url('/relation-tuples', page));
    if (!response.ok) throw new Error(`Keto query answered ${response.status}`);
    const body = (await response.json()) as QueryResponse;
    tuples.push(...(body.relation_tuples ?? []));
    pageToken = body.next_page_token ?? '';
  } while (pageToken);
  return tuples;
}
