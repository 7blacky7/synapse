import {
  MOCK_CHANNEL_FILE_PATTERN,
  MOCK_CHANNEL_IMAGE_PATTERN,
} from './channel-nachrichten-konstanten';

export function splitChannelMessageContent(content: string) {
  const imagePaths: string[] = [];
  const filePaths: string[] = [];
  const text = content
    .replace(MOCK_CHANNEL_IMAGE_PATTERN, (_marker, path: string) => { imagePaths.push(path.trim()); return ''; })
    .replace(MOCK_CHANNEL_FILE_PATTERN, (_marker, path: string) => { filePaths.push(path.trim()); return ''; })
    .trim();
  return { text, imagePaths, filePaths };
}
