import Button from '@app/components/Common/Button';
import LibraryItem from '@app/components/Settings/LibraryItem';
import { ArrowPathIcon } from '@heroicons/react/24/solid';

interface MediaServerLibrary {
  id: string;
  name: string;
  enabled: boolean;
}

interface MediaServerLibrariesPanelProps {
  title: string;
  description: string;
  libraries?: MediaServerLibrary[];
  isSyncing: boolean;
  syncDisabled?: boolean;
  syncLabel: string;
  syncingLabel: string;
  keyPrefix: string;
  onSync: () => void;
  onToggle: (libraryId: string) => void;
}

const MediaServerLibrariesPanel = ({
  title,
  description,
  libraries = [],
  isSyncing,
  syncDisabled = false,
  syncLabel,
  syncingLabel,
  keyPrefix,
  onSync,
  onToggle,
}: MediaServerLibrariesPanelProps) => (
  <>
    <div className="mb-6 mt-10">
      <h3 className="heading">{title}</h3>
      <p className="description">{description}</p>
    </div>
    <div className="section">
      <Button onClick={() => onSync()} disabled={syncDisabled}>
        <ArrowPathIcon
          className={isSyncing ? 'animate-spin' : ''}
          style={{ animationDirection: 'reverse' }}
        />
        <span>{isSyncing ? syncingLabel : syncLabel}</span>
      </Button>
      <ul className="mt-6 grid grid-cols-1 gap-5 sm:grid-cols-2 sm:gap-6 lg:grid-cols-4">
        {libraries.map((library) => (
          <LibraryItem
            name={library.name}
            isEnabled={library.enabled}
            key={`${keyPrefix}-${library.id}`}
            onToggle={() => onToggle(library.id)}
          />
        ))}
      </ul>
    </div>
  </>
);

export default MediaServerLibrariesPanel;
