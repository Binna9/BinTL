export interface ApiSuccess {
  ok: boolean;
}

export interface RunJobResponse extends ApiSuccess {
  id: string;
  status: string;
}

export interface TestConnectionResponse extends ApiSuccess {
  driver: string;
}
