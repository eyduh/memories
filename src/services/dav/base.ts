import { getCurrentUser } from "@nextcloud/auth";
import { showError } from "@nextcloud/dialogs";
import { translate as t } from "@nextcloud/l10n";
import { IFileInfo } from "../../types";
import client from "../DavClient";
import { genFileInfo } from "../FileUtils";

export const props = `
    <oc:fileid />
    <oc:permissions />
    <d:getlastmodified />
    <d:getetag />
    <d:getcontenttype />
    <d:getcontentlength />
    <nc:has-preview />
    <oc:favorite />
    <d:resourcetype />`;

export const IMAGE_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/heic",
  "image/png",
  "image/tiff",
  "image/gif",
  "image/bmp",
  "video/mpeg",
  "video/webm",
  "video/mp4",
  "video/quicktime",
  "video/x-matroska",
];

const GET_FILE_CHUNK_SIZE = 50;

/**
 * Get file infos for list of files given Ids
 * @param fileIds list of file ids
 * @returns list of file infos
 */
export async function getFiles(fileIds: number[]): Promise<IFileInfo[]> {
  // Divide fileIds into chunks of GET_FILE_CHUNK_SIZE
  const chunks = [];
  for (let i = 0; i < fileIds.length; i += GET_FILE_CHUNK_SIZE) {
    chunks.push(fileIds.slice(i, i + GET_FILE_CHUNK_SIZE));
  }

  // Get file infos for each chunk
  const fileInfos = await Promise.all(chunks.map(getFilesInternal));
  return fileInfos.flat();
}

/**
 * Get file infos for list of files given Ids
 * @param fileIds list of file ids (smaller than 100)
 * @returns list of file infos
 */
async function getFilesInternal(fileIds: number[]): Promise<IFileInfo[]> {
  const prefixPath = `/files/${getCurrentUser()!.uid}`;

  // IMPORTANT: if this isn't there, then a blank
  // returns EVERYTHING on the server!
  if (fileIds.length === 0) {
    return [];
  }

  const filter = fileIds
    .map(
      (fileId) => `
        <d:eq>
            <d:prop>
                <oc:fileid/>
            </d:prop>
            <d:literal>${fileId}</d:literal>
        </d:eq>
    `
    )
    .join("");

  const options = {
    method: "SEARCH",
    headers: {
      "content-Type": "text/xml",
    },
    data: `<?xml version="1.0" encoding="UTF-8"?>
            <d:searchrequest xmlns:d="DAV:"
                xmlns:oc="http://owncloud.org/ns"
                xmlns:nc="http://nextcloud.org/ns"
                xmlns:ns="https://github.com/icewind1991/SearchDAV/ns"
                xmlns:ocs="http://open-collaboration-services.org/ns">
                <d:basicsearch>
                    <d:select>
                        <d:prop>
                            ${props}
                        </d:prop>
                    </d:select>
                    <d:from>
                        <d:scope>
                            <d:href>${prefixPath}</d:href>
                            <d:depth>0</d:depth>
                        </d:scope>
                    </d:from>
                    <d:where>
                        <d:or>
                            ${filter}
                        </d:or>
                    </d:where>
                </d:basicsearch>
            </d:searchrequest>`,
    deep: true,
    details: true,
    responseType: "text",
  };

  let response: any = await client.getDirectoryContents("", options);
  return response.data
    .map((data: any) => genFileInfo(data))
    .map((data: any) =>
      Object.assign({}, data, {
        originalFilename: data.filename,
        filename: data.filename.replace(prefixPath, ""),
      })
    );
}

/**
 * Run promises in parallel, but only n at a time
 * @param promises Array of promise generator funnction (async functions)
 * @param n Number of promises to run in parallel
 */
export async function* runInParallel<T>(
  promises: (() => Promise<T>)[],
  n: number
) {
  while (promises.length > 0) {
    const promisesToRun = promises.splice(0, n);
    const resultsForThisBatch = await Promise.all(
      promisesToRun.map((p) => p())
    );
    yield resultsForThisBatch;
  }
  return;
}

/**
 * Delete a single file
 *
 * @param path path to the file
 */
export async function deleteFile(path: string) {
  const prefixPath = `/files/${getCurrentUser()!.uid}`;
  return await client.deleteFile(`${prefixPath}${path}`);
}

/**
 * Delete all files in a given list of Ids
 *
 * @param fileIds list of file ids
 * @returns list of file ids that were deleted
 */
export async function* deleteFilesByIds(fileIds: number[]) {
  const fileIdsSet = new Set(fileIds);

  if (fileIds.length === 0) {
    return;
  }

  // Get files data
  let fileInfos: any[] = [];
  try {
    fileInfos = await getFiles(fileIds.filter((f) => f));
  } catch (e) {
    console.error("Failed to get file info for files to delete", fileIds, e);
    showError(t("memories", "Failed to delete files."));
    return;
  }

  // Delete each file
  fileInfos = fileInfos.filter((f) => fileIdsSet.has(f.fileid));
  const calls = fileInfos.map((fileInfo) => async () => {
    try {
      await deleteFile(fileInfo.filename);
      return fileInfo.fileid as number;
    } catch (error) {
      console.error("Failed to delete", fileInfo, error);
      showError(t("memories", "Failed to delete {fileName}.", fileInfo));
      return 0;
    }
  });

  yield* runInParallel(calls, 10);
}