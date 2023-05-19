import type { PlexMetadata } from '@server/api/plexapi';
import PlexAPI from '@server/api/plexapi';
import type { RadarrMovie } from '@server/api/servarr/radarr';
import RadarrAPI from '@server/api/servarr/radarr';
import type { SonarrSeason, SonarrSeries } from '@server/api/servarr/sonarr';
import SonarrAPI from '@server/api/servarr/sonarr';
import { MediaStatus } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import type Season from '@server/entity/Season';
import { User } from '@server/entity/User';
import type { RadarrSettings, SonarrSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';

class AvailabilitySync {
  public running = false;
  private plexClient: PlexAPI;
  private plexSeasonsCache: Record<string, PlexMetadata[]> = {};
  private sonarrSeasonsCache: Record<string, SonarrSeason[]> = {};
  private radarrServers: RadarrSettings[];
  private sonarrServers: SonarrSettings[];

  async run() {
    const settings = getSettings();
    this.running = true;
    this.plexSeasonsCache = {};
    this.sonarrSeasonsCache = {};
    this.radarrServers = settings.radarr.filter((server) => server.syncEnabled);
    this.sonarrServers = settings.sonarr.filter((server) => server.syncEnabled);

    try {
      await this.initPlexClient();

      if (!this.plexClient) {
        return;
      }

      logger.info(`Starting availability sync...`, {
        label: 'AvailabilitySync',
      });

      const mediaRepository = getRepository(Media);

      const pageSize = 50;

      for await (const media of this.loadAvailableMediaPaginated(pageSize)) {
        if (!this.running) {
          throw new Error('Job aborted');
        }

        const mediaExists = await this.mediaExists(media);
        let didDeleteSeasons = false;

        // If media is missing completely,
        // we will change both statuses to deleted
        // and related columns to null
        if (!mediaExists) {
          if (
            (media.status !== MediaStatus.DELETED ||
              media.status4k !== MediaStatus.DELETED) &&
            (media.status !== MediaStatus.UNKNOWN ||
              media.status4k !== MediaStatus.UNKNOWN)
          ) {
            logger.info(
              `Media with TMDB ID ${media.tmdbId} does not exist in any of your media instances. Status will be changed to deleted.`,
              { label: 'AvailabilitySync' }
            );

            (media.status =
              media.status !== MediaStatus.UNKNOWN
                ? MediaStatus.DELETED
                : MediaStatus.UNKNOWN),
              (media.status4k =
                media.status4k !== MediaStatus.UNKNOWN
                  ? MediaStatus.DELETED
                  : MediaStatus.UNKNOWN),
              (media.serviceId = null),
              (media.serviceId4k = null),
              (media.externalServiceId = null),
              (media.externalServiceId4k = null),
              (media.externalServiceSlug = null),
              (media.externalServiceSlug4k = null),
              (media.ratingKey = null),
              (media.ratingKey4k = null);
          }
        }

        if (media.mediaType === 'tv') {
          for (const season of media.seasons) {
            // If the show has been completely removed,
            // we need to set all available seasons to deleted
            if (
              !mediaExists &&
              (season.status !== MediaStatus.DELETED ||
                season.status4k !== MediaStatus.DELETED) &&
              (season.status !== MediaStatus.UNKNOWN ||
                season.status4k !== MediaStatus.UNKNOWN)
            ) {
              season.status = MediaStatus.DELETED;
              season.status4k = MediaStatus.DELETED;
            } else {
              // If the show still exists,
              // we need to check each individual season for removal
              const seasonExists = await this.seasonExists(media, season);

              if (!seasonExists) {
                logger.info(
                  `Removing season ${season.seasonNumber}, media with TMDB ID ${media.tmdbId} because it does not exist in any of your media instances.`,
                  { label: 'AvailabilitySync' }
                );

                if (
                  (season.status !== MediaStatus.DELETED ||
                    season.status4k !== MediaStatus.DELETED) &&
                  (season.status !== MediaStatus.UNKNOWN ||
                    season.status4k !== MediaStatus.UNKNOWN)
                ) {
                  season.status = MediaStatus.DELETED;
                  season.status4k = MediaStatus.DELETED;
                }

                didDeleteSeasons = true;
              }
            }

            if (didDeleteSeasons) {
              if (
                media.status === MediaStatus.AVAILABLE ||
                media.status4k === MediaStatus.AVAILABLE
              ) {
                logger.info(
                  `Marking media with TMDB ID ${media.tmdbId} as PARTIALLY_AVAILABLE because season removal has occurred.`,
                  { label: 'AvailabilitySync' }
                );

                if (media.status === MediaStatus.AVAILABLE) {
                  media.status = MediaStatus.PARTIALLY_AVAILABLE;
                }

                if (media.status4k === MediaStatus.AVAILABLE) {
                  media.status4k = MediaStatus.PARTIALLY_AVAILABLE;
                }
              }
            }
          }
        }
        if (!mediaExists || didDeleteSeasons) {
          await mediaRepository.save(media);
        }
      }
    } catch (ex) {
      logger.error('Failed to complete availability sync.', {
        errorMessage: ex.message,
        label: 'AvailabilitySync',
      });
    } finally {
      logger.info(`Availability sync complete.`, {
        label: 'AvailabilitySync',
      });
      this.running = false;
    }
  }

  public cancel() {
    this.running = false;
  }

  private async *loadAvailableMediaPaginated(pageSize: number) {
    let offset = 0;
    const mediaRepository = getRepository(Media);
    const whereOptions = [
      { status: MediaStatus.AVAILABLE },
      { status: MediaStatus.PARTIALLY_AVAILABLE },
      { status4k: MediaStatus.AVAILABLE },
      { status4k: MediaStatus.PARTIALLY_AVAILABLE },
    ];

    let mediaPage: Media[];

    do {
      yield* (mediaPage = await mediaRepository.find({
        where: whereOptions,
        skip: offset,
        take: pageSize,
      }));
      offset += pageSize;
    } while (mediaPage.length > 0);
  }

  private async mediaUpdater(media: Media, is4k: boolean): Promise<void> {
    const mediaRepository = getRepository(Media);
    const isTypeTV = media.mediaType === 'tv';

    logger.info(
      `Media with TMDB ID ${media.tmdbId} does not exist in your ${
        is4k ? '4k' : 'non-4k'
      } ${
        isTypeTV ? 'Sonarr' : 'Radarr'
      } and Plex instance. Status will be changed to deleted.`,
      { label: 'AvailabilitySync' }
    );

    // Set the non-4K or 4K media to deleted
    // and change related columns to null
    (media[is4k ? 'status4k' : 'status'] = MediaStatus.DELETED),
      (media[is4k ? 'serviceId4k' : 'serviceId'] = null),
      (media[is4k ? 'externalServiceId4k' : 'externalServiceId'] = null),
      (media[is4k ? 'externalServiceSlug4k' : 'externalServiceSlug'] = null),
      (media[is4k ? 'ratingKey4k' : 'ratingKey'] = null);

    // If type is TV,
    // update related seasons to deleted as well
    if (isTypeTV) {
      media.seasons.forEach((season) => {
        if (season[is4k ? 'status4k' : 'status'] === MediaStatus.AVAILABLE) {
          season[is4k ? 'status4k' : 'status'] = MediaStatus.DELETED;
        }
      });
    }
    try {
      await mediaRepository.save(media);
    } catch (ex) {
      logger.debug(`Failure updating media with TMDB ID ${media.tmdbId}`, {
        errorMessage: ex.message,
        label: 'AvailabilitySync',
      });
    }
  }

  private async mediaExistsInRadarr(
    media: Media,
    existsInPlex: boolean,
    existsInPlex4k: boolean
  ): Promise<boolean> {
    let existsInRadarr = true;
    let existsInRadarr4k = true;

    for (const server of this.radarrServers) {
      const api = new RadarrAPI({
        apiKey: server.apiKey,
        url: RadarrAPI.buildUrl(server, '/api/v3'),
      });
      try {
        // Check if both exist or if a single non-4k or 4k exists
        // If both do not exist we will return false
        let radarr: RadarrMovie | undefined;

        if (!server.is4k && media.externalServiceId) {
          radarr = await api.getMovie({ id: media.externalServiceId });
        }

        if (server.is4k && media.externalServiceId4k) {
          radarr = await api.getMovie({ id: media.externalServiceId4k });
        }

        if (!server.is4k && (!radarr || !radarr.hasFile)) {
          existsInRadarr = false;
        }

        if (server.is4k && (!radarr || !radarr.hasFile)) {
          existsInRadarr4k = false;
        }
      } catch (ex) {
        logger.debug(
          `Failure retrieving media with TMDB ID ${media.tmdbId} from your ${
            !server.is4k ? 'non-4K' : '4K'
          } Radarr.`,
          {
            errorMessage: ex.message,
            label: 'AvailabilitySync',
          }
        );
        if (!server.is4k) {
          existsInRadarr = false;
        }

        if (server.is4k) {
          existsInRadarr4k = false;
        }
      }
    }

    // If only a single non-4k or 4k exists,
    // Change entity columns accordingly
    // The related media request will then be deleted
    if (
      !existsInRadarr &&
      (existsInRadarr4k || existsInPlex4k) &&
      !existsInPlex
    ) {
      if (
        media.status !== MediaStatus.DELETED &&
        media.status !== MediaStatus.UNKNOWN
      ) {
        this.mediaUpdater(media, false);
      }
    }

    if (
      (existsInRadarr || existsInPlex) &&
      !existsInRadarr4k &&
      !existsInPlex4k
    ) {
      if (
        media.status4k !== MediaStatus.DELETED &&
        media.status4k !== MediaStatus.UNKNOWN
      ) {
        this.mediaUpdater(media, true);
      }
    }

    if (existsInRadarr || existsInRadarr4k || existsInPlex || existsInPlex4k) {
      return true;
    }

    return false;
  }

  private async mediaExistsInSonarr(
    media: Media,
    existsInPlex: boolean,
    existsInPlex4k: boolean
  ): Promise<boolean> {
    let existsInSonarr = true;
    let existsInSonarr4k = true;

    for (const server of this.sonarrServers) {
      const api = new SonarrAPI({
        apiKey: server.apiKey,
        url: SonarrAPI.buildUrl(server, '/api/v3'),
      });
      try {
        // Check if both exist or if a single non-4k or 4k exists
        // If both do not exist we will return false
        let sonarr: SonarrSeries | undefined;

        if (!server.is4k && media.externalServiceId) {
          sonarr = await api.getSeriesById(media.externalServiceId);
          this.sonarrSeasonsCache[`${server.id}-${media.externalServiceId}`] =
            sonarr.seasons;
        }

        if (server.is4k && media.externalServiceId4k) {
          sonarr = await api.getSeriesById(media.externalServiceId4k);
          this.sonarrSeasonsCache[`${server.id}-${media.externalServiceId4k}`] =
            sonarr.seasons;
        }

        if (
          !server.is4k &&
          (!sonarr || sonarr.statistics.episodeFileCount === 0)
        ) {
          existsInSonarr = false;
        }

        if (
          server.is4k &&
          (!sonarr || sonarr.statistics.episodeFileCount === 0)
        ) {
          existsInSonarr4k = false;
        }
      } catch (ex) {
        logger.debug(
          `Failure retrieving media with TMDB ID ${media.tmdbId} from your ${
            !server.is4k ? 'non-4K' : '4K'
          } Sonarr.`,
          {
            errorMessage: ex.message,
            label: 'AvailabilitySync',
          }
        );

        if (!server.is4k) {
          existsInSonarr = false;
        }

        if (server.is4k) {
          existsInSonarr4k = false;
        }
      }
    }

    // If only a single non-4k or 4k exists,
    // Change entity columns accordingly
    // The related media request will then be deleted
    if (
      !existsInSonarr &&
      (existsInSonarr4k || existsInPlex4k) &&
      !existsInPlex
    ) {
      if (
        media.status !== MediaStatus.DELETED &&
        media.status !== MediaStatus.UNKNOWN
      ) {
        this.mediaUpdater(media, false);
      }
    }

    if (
      (existsInSonarr || existsInPlex) &&
      !existsInSonarr4k &&
      !existsInPlex4k
    ) {
      if (
        media.status4k !== MediaStatus.DELETED &&
        media.status4k !== MediaStatus.UNKNOWN
      ) {
        this.mediaUpdater(media, true);
      }
    }

    if (existsInSonarr || existsInSonarr4k || existsInPlex || existsInPlex4k) {
      return true;
    }

    return false;
  }

  private async seasonExistsInSonarr(
    media: Media,
    season: Season,
    seasonExistsInPlex: boolean,
    seasonExistsInPlex4k: boolean
  ): Promise<boolean> {
    let seasonExistsInSonarr = true;
    let seasonExistsInSonarr4k = true;

    const mediaRepository = getRepository(Media);
    // const seasonRepository = getRepository(Season);

    for (const server of this.sonarrServers) {
      const api = new SonarrAPI({
        apiKey: server.apiKey,
        url: SonarrAPI.buildUrl(server, '/api/v3'),
      });

      try {
        // Here we can use the cache we built
        // when we fetched the series with mediaExistsInSonarr
        // If the cache does not have data, fetch with the api route
        let sonarrSeasons: SonarrSeason[] =
          this.sonarrSeasonsCache[
            `${server.id}-${
              !server.is4k ? media.externalServiceId : media.externalServiceId4k
            }`
          ];

        if (!server.is4k && media.externalServiceId) {
          sonarrSeasons =
            this.sonarrSeasonsCache[
              `${server.id}-${media.externalServiceId}`
            ] ?? (await api.getSeriesById(media.externalServiceId)).seasons;
          this.sonarrSeasonsCache[`${server.id}-${media.externalServiceId}`] =
            sonarrSeasons;
        }

        if (server.is4k && media.externalServiceId4k) {
          sonarrSeasons =
            this.sonarrSeasonsCache[
              `${server.id}-${media.externalServiceId4k}`
            ] ?? (await api.getSeriesById(media.externalServiceId4k)).seasons;
          this.sonarrSeasonsCache[`${server.id}-${media.externalServiceId4k}`] =
            sonarrSeasons;
        }

        const seasonIsUnavailable = sonarrSeasons?.find(
          ({ seasonNumber, statistics }) =>
            season.seasonNumber === seasonNumber &&
            statistics?.episodeFileCount === 0
        );

        if (!server.is4k && seasonIsUnavailable) {
          seasonExistsInSonarr = false;
        }

        if (server.is4k && seasonIsUnavailable) {
          seasonExistsInSonarr4k = false;
        }
      } catch (ex) {
        logger.debug(
          `Failure retrieving media with TMDB ID ${media.tmdbId} from your ${
            !server.is4k ? 'non-4K' : '4K'
          } Sonarr.`,
          {
            errorMessage: ex.message,
            label: 'AvailabilitySync',
          }
        );

        if (!server.is4k) {
          seasonExistsInSonarr = false;
        }

        if (server.is4k) {
          seasonExistsInSonarr4k = false;
        }
      }
    }

    // If season does not exist, change its status to deleted and
    // then delete the related season request
    // If parent media request is empty (all related seasons have been set to deleted),
    // the parent is automatically set to deleted
    if (
      !seasonExistsInSonarr &&
      (seasonExistsInSonarr4k || seasonExistsInPlex4k) &&
      !seasonExistsInPlex
    ) {
      if (
        season.status !== MediaStatus.DELETED &&
        season.status !== MediaStatus.UNKNOWN
      ) {
        logger.info(
          `Season ${season.seasonNumber}, media with TMDB ID ${media.tmdbId} does not exist in your non-4k Sonarr and Plex instance. Status will be changed to deleted.`,
          { label: 'AvailabilitySync' }
        );
        season.status = MediaStatus.DELETED;

        if (media.status === MediaStatus.AVAILABLE) {
          logger.info(
            `Marking media with TMDB ID ${media.tmdbId} as PARTIALLY_AVAILABLE because season removal has occurred.`,
            { label: 'AvailabilitySync' }
          );
          media.status = MediaStatus.PARTIALLY_AVAILABLE;
        }
      }
    }

    if (
      (seasonExistsInSonarr || seasonExistsInPlex) &&
      !seasonExistsInSonarr4k &&
      !seasonExistsInPlex4k
    ) {
      if (
        season.status4k !== MediaStatus.DELETED &&
        season.status4k !== MediaStatus.UNKNOWN
      ) {
        logger.info(
          `Season ${season.seasonNumber}, media with TMDB ID ${media.tmdbId} does not exist in your 4k Sonarr and Plex instance. Status will be changed to deleted.`,
          { label: 'AvailabilitySync' }
        );
        season.status4k = MediaStatus.DELETED;

        if (media.status4k === MediaStatus.AVAILABLE) {
          logger.info(
            `Marking media with TMDB ID ${media.tmdbId} as PARTIALLY_AVAILABLE because season removal has occurred.`,
            { label: 'AvailabilitySync' }
          );
          media.status4k = MediaStatus.PARTIALLY_AVAILABLE;
        }
      }
    }

    if (!seasonExistsInSonarr || !seasonExistsInSonarr4k) {
      media.seasons = [...media.seasons, season];
      try {
        await mediaRepository.save(media);
      } catch (ex) {
        logger.debug(`Failure updating media with TMDB ID ${media.tmdbId}`, {
          errorMessage: ex.message,
          label: 'AvailabilitySync',
        });
      }
    }

    if (
      seasonExistsInSonarr ||
      seasonExistsInSonarr4k ||
      seasonExistsInPlex ||
      seasonExistsInPlex4k
    ) {
      return true;
    }

    return false;
  }

  private async mediaExists(media: Media): Promise<boolean> {
    const ratingKey = media.ratingKey;
    const ratingKey4k = media.ratingKey4k;

    let existsInPlex = false;
    let existsInPlex4k = false;

    // Check each plex instance to see if media exists
    try {
      if (ratingKey) {
        const meta = await this.plexClient?.getMetadata(ratingKey);
        if (meta) {
          existsInPlex = true;
        }
      }

      if (ratingKey4k) {
        const meta4k = await this.plexClient?.getMetadata(ratingKey4k);
        if (meta4k) {
          existsInPlex4k = true;
        }
      }
    } catch (ex) {
      if (!ex.message.includes('response code: 404')) {
        logger.debug(`Failed to retrieve plex metadata`, {
          errorMessage: ex.message,
          label: 'AvailabilitySync',
        });
      }
    }
    // Base case if both media versions exist in plex
    if (existsInPlex && existsInPlex4k) {
      return true;
    }

    // We then check radarr or sonarr has that specific media.
    // If not, then we will move to delete
    // If a non-4k or 4k version exists in at least one of the instances,
    // we will only update that specific version
    if (media.mediaType === 'movie') {
      const existsInRadarr = await this.mediaExistsInRadarr(
        media,
        existsInPlex,
        existsInPlex4k
      );

      // If true, media exists in at least one radarr or plex instance.
      if (existsInRadarr) {
        logger.warn(
          `Media ID ${media.id} exists in at least one Radarr or Plex instance. Media will be updated if set to available.`,
          {
            label: 'AvailabilitySync',
          }
        );

        return true;
      }
    }

    if (media.mediaType === 'tv') {
      const existsInSonarr = await this.mediaExistsInSonarr(
        media,
        existsInPlex,
        existsInPlex4k
      );

      // If true, media exists in at least one sonarr or plex instance.
      if (existsInSonarr) {
        logger.warn(
          `Media ID ${media.id} exists in at least one Sonarr or Plex instance. Media will be updated if set to available.`,
          {
            label: 'AvailabilitySync',
          }
        );

        return true;
      }
    }

    return false;
  }

  private async seasonExists(media: Media, season: Season) {
    const ratingKey = media.ratingKey;
    const ratingKey4k = media.ratingKey4k;

    let seasonExistsInPlex = false;
    let seasonExistsInPlex4k = false;

    try {
      if (ratingKey) {
        const children =
          this.plexSeasonsCache[ratingKey] ??
          (await this.plexClient?.getChildrenMetadata(ratingKey)) ??
          [];
        this.plexSeasonsCache[ratingKey] = children;
        const seasonMeta = children?.find(
          (child) => child.index === season.seasonNumber
        );

        if (seasonMeta) {
          seasonExistsInPlex = true;
        }
      }
      if (ratingKey4k) {
        const children4k =
          this.plexSeasonsCache[ratingKey4k] ??
          (await this.plexClient?.getChildrenMetadata(ratingKey4k)) ??
          [];
        this.plexSeasonsCache[ratingKey4k] = children4k;
        const seasonMeta4k = children4k?.find(
          (child) => child.index === season.seasonNumber
        );

        if (seasonMeta4k) {
          seasonExistsInPlex4k = true;
        }
      }
    } catch (ex) {
      if (!ex.message.includes('response code: 404')) {
        logger.debug(`Failed to retrieve plex's children metadata`, {
          errorMessage: ex.message,
          label: 'AvailabilitySync',
        });
      }
    }
    // Base case if both season versions exist in plex
    if (seasonExistsInPlex && seasonExistsInPlex4k) {
      return true;
    }

    const existsInSonarr = await this.seasonExistsInSonarr(
      media,
      season,
      seasonExistsInPlex,
      seasonExistsInPlex4k
    );

    if (existsInSonarr) {
      logger.warn(
        `Season ${season.seasonNumber}, media ID ${media.id} exists in at least one Sonarr or Plex instance. Media will be updated if set to available.`,
        {
          label: 'AvailabilitySync',
        }
      );

      return true;
    }

    return false;
  }

  private async initPlexClient() {
    const userRepository = getRepository(User);
    const admin = await userRepository.findOne({
      select: { id: true, plexToken: true },
      where: { id: 1 },
    });

    if (!admin) {
      logger.warning('No admin configured. Availability sync skipped.');
      return;
    }

    this.plexClient = new PlexAPI({ plexToken: admin.plexToken });
  }
}

const availabilitySync = new AvailabilitySync();
export default availabilitySync;
