export type Theme = 'dark' | 'light';

export interface Props {
  project: string;
  onLogout: () => void;
}
