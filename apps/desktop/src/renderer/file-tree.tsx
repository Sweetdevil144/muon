import type { WorkspaceReview } from "../shared/ipc.js";

type AvailableWorkspaceReview = Extract<
  WorkspaceReview,
  { status: "available" }
>;

export type WorkspaceFileStat = AvailableWorkspaceReview["fileStats"][number];

type FileNode = {
  name: string;
  path: string;
  normalizedPath: string;
};

export type FolderNode = {
  name: string;
  path: string;
  folders: FolderNode[];
  files: FileNode[];
};

type MutableFolderNode = {
  name: string;
  path: string;
  folders: Map<string, MutableFolderNode>;
  files: FileNode[];
};

function normalizePath(path: string): string {
  return path
    .replaceAll("\\", "/")
    .replace(/^\.\/+/, "")
    .replace(/^\/+|\/+$/g, "");
}

function freezeFolder(node: MutableFolderNode): FolderNode {
  return {
    name: node.name,
    path: node.path,
    folders: [...node.folders.values()]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map(freezeFolder),
    files: [...node.files].sort((left, right) =>
      left.name.localeCompare(right.name)
    ),
  };
}

export function buildFileTree(files: ReadonlyArray<string>): FolderNode {
  const root: MutableFolderNode = {
    name: "",
    path: "",
    folders: new Map(),
    files: [],
  };
  const seen = new Set<string>();

  for (const path of files) {
    const normalizedPath = normalizePath(path);
    if (!normalizedPath || seen.has(normalizedPath)) {
      continue;
    }
    seen.add(normalizedPath);

    const segments = normalizedPath.split("/").filter(Boolean);
    const name = segments.pop();
    if (!name) {
      continue;
    }

    let folder = root;
    for (const segment of segments) {
      const folderPath = folder.path ? `${folder.path}/${segment}` : segment;
      const existing = folder.folders.get(segment);
      if (existing) {
        folder = existing;
        continue;
      }
      const next: MutableFolderNode = {
        name: segment,
        path: folderPath,
        folders: new Map(),
        files: [],
      };
      folder.folders.set(segment, next);
      folder = next;
    }

    folder.files.push({
      name,
      path,
      normalizedPath,
    });
  }

  return freezeFolder(root);
}

function countFiles(folder: FolderNode): number {
  return (
    folder.files.length +
    folder.folders.reduce((total, child) => total + countFiles(child), 0)
  );
}

export function FileChangeBadge(props: {
  stat: WorkspaceFileStat | undefined;
}) {
  if (!props.stat) {
    return null;
  }
  if (props.stat.binary) {
    return <span className="numstat numstat-binary">binary</span>;
  }
  return (
    <span className="numstat">
      <span className="numstat-add">+{props.stat.additions}</span>
      <span className="numstat-del">−{props.stat.deletions}</span>
    </span>
  );
}

export function FileItem(props: {
  file: FileNode;
  stat: WorkspaceFileStat | undefined;
}) {
  return (
    <li className="file-tree-item">
      <code title={props.file.path}>{props.file.name}</code>
      <FileChangeBadge stat={props.stat} />
    </li>
  );
}

export function FolderRow(props: {
  folder: FolderNode;
  statByPath: ReadonlyMap<string, WorkspaceFileStat>;
}) {
  const fileCount = countFiles(props.folder);
  return (
    <li className="file-tree-folder-row">
      <details className="file-tree-folder" open>
        <summary title={props.folder.path}>
          <span>{props.folder.name}</span>
          <b>{fileCount}</b>
        </summary>
        <ul className="session-change-files file-tree-children">
          {props.folder.folders.map((folder) => (
            <FolderRow
              key={folder.path}
              folder={folder}
              statByPath={props.statByPath}
            />
          ))}
          {props.folder.files.map((file) => (
            <FileItem
              key={file.normalizedPath}
              file={file}
              stat={
                props.statByPath.get(file.path) ??
                props.statByPath.get(file.normalizedPath)
              }
            />
          ))}
        </ul>
      </details>
    </li>
  );
}

export function FileTree(props: {
  files: ReadonlyArray<string>;
  fileStats: ReadonlyArray<WorkspaceFileStat>;
}) {
  if (props.files.length === 0) {
    return <p className="right-panel-empty">No Git changes are currently visible.</p>;
  }

  const tree = buildFileTree(props.files);
  const statByPath = new Map<string, WorkspaceFileStat>();
  for (const stat of props.fileStats) {
    statByPath.set(stat.path, stat);
    statByPath.set(normalizePath(stat.path), stat);
  }

  return (
    <div className="file-tree" aria-label="Workspace file tree">
      <ul className="session-change-files file-tree-root">
        {tree.folders.map((folder) => (
          <FolderRow
            key={folder.path}
            folder={folder}
            statByPath={statByPath}
          />
        ))}
        {tree.files.map((file) => (
          <FileItem
            key={file.normalizedPath}
            file={file}
            stat={
              statByPath.get(file.path) ?? statByPath.get(file.normalizedPath)
            }
          />
        ))}
      </ul>
    </div>
  );
}
