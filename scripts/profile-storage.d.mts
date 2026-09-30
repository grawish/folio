export type ProfileStorageInputs = {
  corpusDirectory?: string;
  rest: string[];
  platform: string;
  arch: string;
};

export function profileStorageRunInputs(input: ProfileStorageInputs): {
  samples: number;
  historyLengths: number[];
  maximumCount: boolean;
};
