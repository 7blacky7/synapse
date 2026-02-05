import { useRef } from 'react';

interface ImageUploadProps {
  onImageSelect: (base64: string | null) => void;
}

function ImageUpload({ onImageSelect }: ImageUploadProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Nur Bilder erlauben
    if (!file.type.startsWith('image/')) {
      alert('Bitte nur Bilddateien hochladen');
      return;
    }

    // Max 10MB
    if (file.size > 10 * 1024 * 1024) {
      alert('Bild ist zu gross (max. 10MB)');
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      onImageSelect(reader.result as string);
    };
    reader.readAsDataURL(file);

    // Input zuruecksetzen
    if (inputRef.current) {
      inputRef.current.value = '';
    }
  };

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        onChange={handleFileChange}
        style={{ display: 'none' }}
        id="image-upload"
      />
      <label htmlFor="image-upload" style={styles.button}>
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
          <circle cx="8.5" cy="8.5" r="1.5" />
          <polyline points="21 15 16 10 5 21" />
        </svg>
      </label>
    </>
  );
}

const styles: Record<string, React.CSSProperties> = {
  button: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '44px',
    height: '44px',
    border: '1px solid #0f3460',
    borderRadius: '8px',
    background: '#1a1a2e',
    color: '#aaa',
    cursor: 'pointer',
    transition: 'all 0.2s',
  },
};

export default ImageUpload;
