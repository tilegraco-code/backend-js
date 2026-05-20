import { supabase } from '../lib/supabase';

export interface ExampleItem {
  id: string;
  name: string;
  created_at?: string;
}

export interface CreateExampleInput {
  name: string;
}

const TABLE = 'examples';

export const exampleService = {
  async list(): Promise<ExampleItem[]> {
    const { data, error } = await supabase
      .from(TABLE)
      .select('*')
      .order('created_at', { ascending: false })
      .limit(100);

    if (error) throw error;
    return (data ?? []) as ExampleItem[];
  },

  async create(input: CreateExampleInput): Promise<ExampleItem> {
    const { data, error } = await supabase
      .from(TABLE)
      .insert(input)
      .select()
      .single();

    if (error) throw error;
    return data as ExampleItem;
  },
};
