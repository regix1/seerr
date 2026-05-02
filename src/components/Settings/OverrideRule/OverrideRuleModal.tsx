import Modal from '@app/components/Common/Modal';
import LanguageSelector from '@app/components/LanguageSelector';
import {
  GenreSelector,
  KeywordSelector,
  UserSelector,
} from '@app/components/Selector';
import type { DVRTestResponse } from '@app/components/Settings/SettingsServices';
import useSettings from '@app/hooks/useSettings';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { Transition } from '@headlessui/react';
import type OverrideRule from '@server/entity/OverrideRule';
import type { RadarrSettings, SonarrSettings } from '@server/lib/settings';
import axios from 'axios';
import { Field, Formik } from 'formik';
import { useCallback, useEffect, useState } from 'react';
import { useIntl } from 'react-intl';
import Select from 'react-select';
import { useToasts } from 'react-toast-notifications';

const messages = defineMessages('components.Settings.OverrideRuleModal', {
  createrule: 'New Override Rule',
  editrule: 'Edit Override Rule',
  create: 'Create rule',
  service: 'Service',
  serviceDescription: 'Apply this rule to the selected service.',
  selectService: 'Select service',
  conditions: 'Conditions',
  conditionsDescription:
    'Specifies conditions before applying parameter changes. Each field must be validated for the rules to be applied (AND operation). A field is considered verified if any of its properties match (OR operation).',
  settings: 'Settings',
  settingsDescription:
    'Specifies which settings will be changed when the above conditions are met.',
  users: 'Users',
  genres: 'Genres',
  languages: 'Languages',
  keywords: 'Keywords',
  rootfolder: 'Root Folder',
  selectRootFolder: 'Select root folder',
  qualityprofile: 'Quality Profile',
  selectQualityProfile: 'Select quality profile',
  tags: 'Tags',
  notagoptions: 'No tags.',
  selecttags: 'Select tags',
  seriesType: 'Series Type',
  seriesTypeDescription:
    'Only apply this rule when the series matches the selected type(s).',
  targetServer: 'Target Server',
  targetServerDescription:
    'Override the destination server when this rule matches.',
  anime: 'Anime',
  standard: 'Standard',
  daily: 'Daily',
  ruleCreated: 'Override rule created successfully!',
  ruleUpdated: 'Override rule updated successfully!',
  errorSavingRule: 'Failed to save override rule.',
});

type OptionType = {
  value: number;
  label: string;
};

interface OverrideRuleModalProps {
  rule: OverrideRule | null;
  onClose: () => void;
  radarrServices: RadarrSettings[];
  sonarrServices: SonarrSettings[];
}

const OverrideRuleModal = ({
  onClose,
  rule,
  radarrServices,
  sonarrServices,
}: OverrideRuleModalProps) => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const { currentSettings } = useSettings();
  const [isValidated, setIsValidated] = useState(rule ? true : false);
  const [isTesting, setIsTesting] = useState(false);
  const [isTestingTarget, setIsTestingTarget] = useState(false);
  const [targetTestResponse, setTargetTestResponse] =
    useState<DVRTestResponse | null>(null);
  const [testResponse, setTestResponse] = useState<DVRTestResponse>({
    profiles: [],
    rootFolders: [],
    tags: [],
  });

  const getServiceInfos = useCallback(
    async (
      {
        hostname,
        port,
        apiKey,
        baseUrl,
        useSsl = false,
      }: {
        hostname: string;
        port: number;
        apiKey: string;
        baseUrl?: string;
        useSsl?: boolean;
      },
      type: 'radarr' | 'sonarr'
    ) => {
      setIsTesting(true);
      try {
        const response = await axios.post<DVRTestResponse>(
          `/api/v1/settings/${type}/test`,
          {
            hostname,
            apiKey,
            port: Number(port),
            baseUrl,
            useSsl,
          }
        );

        setIsValidated(true);
        setTestResponse(response.data);
      } catch {
        setIsValidated(false);
      } finally {
        setIsTesting(false);
      }
    },
    []
  );

  const getTargetServiceInfos = useCallback(
    async (serviceId: number, type: 'radarr' | 'sonarr') => {
      const services = type === 'radarr' ? radarrServices : sonarrServices;
      const service = services.find((s) => s.id === serviceId);
      if (!service) return;
      setIsTestingTarget(true);
      try {
        const response = await axios.post<DVRTestResponse>(
          `/api/v1/settings/${type}/test`,
          {
            hostname: service.hostname,
            apiKey: service.apiKey,
            port: Number(service.port),
            baseUrl: service.baseUrl,
            useSsl: service.useSsl,
          }
        );
        setTargetTestResponse(response.data);
      } catch {
        setTargetTestResponse(null);
      } finally {
        setIsTestingTarget(false);
      }
    },
    [radarrServices, sonarrServices]
  );

  useEffect(() => {
    if (rule?.targetServerId != null) {
      const type = rule?.sonarrServiceId != null ? 'sonarr' : 'radarr';
      getTargetServiceInfos(rule.targetServerId, type);
    }
  }, [rule?.targetServerId, getTargetServiceInfos, rule?.sonarrServiceId]);

  useEffect(() => {
    const radarrMatch = radarrServices.find(
      (s) => s.id === rule?.radarrServiceId
    );
    if (radarrMatch) getServiceInfos(radarrMatch, 'radarr');

    const sonarrMatch = sonarrServices.find(
      (s) => s.id === rule?.sonarrServiceId
    );
    if (sonarrMatch) getServiceInfos(sonarrMatch, 'sonarr');
  }, [
    getServiceInfos,
    radarrServices,
    rule?.radarrServiceId,
    rule?.sonarrServiceId,
    sonarrServices,
  ]);

  return (
    <Transition
      as="div"
      appear
      show
      enter="transition-opacity ease-in-out duration-300"
      enterFrom="opacity-0"
      enterTo="opacity-100"
      leave="transition-opacity ease-in-out duration-300"
      leaveFrom="opacity-100"
      leaveTo="opacity-0"
    >
      <Formik
        initialValues={{
          radarrServiceId: rule?.radarrServiceId,
          sonarrServiceId: rule?.sonarrServiceId,
          users: rule?.users,
          genre: rule?.genre,
          language: rule?.language,
          keywords: rule?.keywords,
          profileId: rule?.profileId,
          rootFolder: rule?.rootFolder,
          tags: rule?.tags,
          seriesType: rule?.seriesType,
          targetServerId: rule?.targetServerId,
        }}
        onSubmit={async (values) => {
          try {
            const submission = {
              users: values.users || null,
              genre: values.genre || null,
              language: values.language || null,
              keywords: values.keywords || null,
              profileId: Number(values.profileId) || null,
              rootFolder: values.rootFolder || null,
              tags: values.tags || null,
              radarrServiceId: values.radarrServiceId,
              sonarrServiceId: values.sonarrServiceId,
              seriesType: values.seriesType || null,
              targetServerId:
                values.targetServerId != null
                  ? Number(values.targetServerId)
                  : null,
            };
            if (!rule) {
              await axios.post('/api/v1/overrideRule', submission);
              addToast(intl.formatMessage(messages.ruleCreated), {
                appearance: 'success',
                autoDismiss: true,
              });
            } else {
              await axios.put(`/api/v1/overrideRule/${rule.id}`, submission);
              addToast(intl.formatMessage(messages.ruleUpdated), {
                appearance: 'success',
                autoDismiss: true,
              });
            }
            onClose();
          } catch {
            addToast(intl.formatMessage(messages.errorSavingRule), {
              appearance: 'error',
              autoDismiss: true,
            });
          }
        }}
      >
        {({
          errors,
          touched,
          values,
          handleSubmit,
          setFieldValue,
          isSubmitting,
          isValid,
        }) => {
          const activeTestResponse =
            values.targetServerId != null && targetTestResponse
              ? targetTestResponse
              : testResponse;
          const isLoadingTarget =
            values.targetServerId != null && isTestingTarget;
          return (
            <Modal
              onCancel={onClose}
              okButtonType="primary"
              okText={
                isSubmitting
                  ? intl.formatMessage(globalMessages.saving)
                  : rule
                    ? intl.formatMessage(globalMessages.save)
                    : intl.formatMessage(messages.create)
              }
              okDisabled={
                isSubmitting ||
                !isValid ||
                (!values.users &&
                  !values.genre &&
                  !values.language &&
                  !values.keywords &&
                  !values.seriesType) ||
                (!values.rootFolder &&
                  !values.profileId &&
                  !values.tags &&
                  values.targetServerId == null)
              }
              onOk={() => handleSubmit()}
              title={
                !rule
                  ? intl.formatMessage(messages.createrule)
                  : intl.formatMessage(messages.editrule)
              }
            >
              <div className="mb-6">
                <h3 className="text-lg font-bold leading-8 text-gray-100">
                  {intl.formatMessage(messages.service)}
                </h3>
                <p className="description">
                  {intl.formatMessage(messages.serviceDescription)}
                </p>
                <div className="form-row">
                  <label htmlFor="service" className="text-label">
                    {intl.formatMessage(messages.service)}
                  </label>
                  <div className="form-input-area">
                    <div className="form-input-field">
                      <select
                        id="service"
                        name="service"
                        defaultValue={
                          values.radarrServiceId !== null
                            ? `radarr-${values.radarrServiceId}`
                            : `sonarr-${values.sonarrServiceId}`
                        }
                        onChange={(e) => {
                          const id = Number(e.target.value.split('-')[1]);
                          if (e.target.value.startsWith('radarr-')) {
                            setFieldValue('radarrServiceId', id);
                            setFieldValue('sonarrServiceId', null);
                            setFieldValue('seriesType', null);
                            setFieldValue('targetServerId', null);
                            setTargetTestResponse(null);
                            const match = radarrServices.find(
                              (s) => s.id === id
                            );
                            if (match) {
                              getServiceInfos(match, 'radarr');
                            }
                          } else if (e.target.value.startsWith('sonarr-')) {
                            setFieldValue('radarrServiceId', null);
                            setFieldValue('sonarrServiceId', id);
                            setFieldValue('targetServerId', null);
                            setTargetTestResponse(null);
                            const match = sonarrServices.find(
                              (s) => s.id === id
                            );
                            if (match) {
                              getServiceInfos(match, 'sonarr');
                            }
                          } else {
                            setFieldValue('radarrServiceId', null);
                            setFieldValue('sonarrServiceId', null);
                            setFieldValue('seriesType', null);
                            setFieldValue('targetServerId', null);
                            setTargetTestResponse(null);
                            setIsValidated(false);
                          }
                        }}
                      >
                        <option value="">
                          {intl.formatMessage(messages.selectService)}
                        </option>
                        {radarrServices.map((radarr) => (
                          <option
                            key={`radarr-${radarr.id}`}
                            value={`radarr-${radarr.id}`}
                          >
                            {radarr.name}
                          </option>
                        ))}
                        {sonarrServices.map((sonarr) => (
                          <option
                            key={`sonarr-${sonarr.id}`}
                            value={`sonarr-${sonarr.id}`}
                          >
                            {sonarr.name}
                          </option>
                        ))}
                      </select>
                    </div>
                    {errors.rootFolder &&
                      touched.rootFolder &&
                      typeof errors.rootFolder === 'string' && (
                        <div className="error">{errors.rootFolder}</div>
                      )}
                  </div>
                </div>
                <h3 className="text-lg font-bold leading-8 text-gray-100">
                  {intl.formatMessage(messages.conditions)}
                </h3>
                <p className="description">
                  {intl.formatMessage(messages.conditionsDescription)}
                </p>
                <div className="form-row">
                  <label htmlFor="users" className="text-label">
                    {intl.formatMessage(messages.users)}
                  </label>
                  <div className="form-input-area">
                    <div className="form-input-field">
                      <UserSelector
                        defaultValue={values.users}
                        isDisabled={!isValidated || isTesting}
                        isMulti
                        onChange={(users) => {
                          setFieldValue(
                            'users',
                            users?.map((v) => v.value).join(',')
                          );
                        }}
                      />
                    </div>
                    {errors.users &&
                      touched.users &&
                      typeof errors.users === 'string' && (
                        <div className="error">{errors.users}</div>
                      )}
                  </div>
                </div>
                <div className="form-row">
                  <label htmlFor="genre" className="text-label">
                    {intl.formatMessage(messages.genres)}
                  </label>
                  <div className="form-input-area">
                    <div className="form-input-field">
                      <GenreSelector
                        type={
                          values.radarrServiceId != null
                            ? 'movie'
                            : values.sonarrServiceId != null
                              ? 'tv'
                              : 'tv'
                        }
                        defaultValue={values.genre}
                        isMulti
                        isDisabled={!isValidated || isTesting}
                        onChange={(genres) => {
                          setFieldValue(
                            'genre',
                            genres?.map((v) => v.value).join(',')
                          );
                        }}
                      />
                    </div>
                    {errors.genre &&
                      touched.genre &&
                      typeof errors.genre === 'string' && (
                        <div className="error">{errors.genre}</div>
                      )}
                  </div>
                </div>
                <div className="form-row">
                  <label htmlFor="language" className="text-label">
                    {intl.formatMessage(messages.languages)}
                  </label>
                  <div className="form-input-area">
                    <div className="form-input-field">
                      <LanguageSelector
                        value={values.language}
                        serverValue={currentSettings.originalLanguage}
                        setFieldValue={(_key, value) => {
                          setFieldValue('language', value);
                        }}
                        isDisabled={!isValidated || isTesting}
                      />
                    </div>
                    {errors.language &&
                      touched.language &&
                      typeof errors.language === 'string' && (
                        <div className="error">{errors.language}</div>
                      )}
                  </div>
                </div>
                <div className="form-row">
                  <label htmlFor="keywords" className="text-label">
                    {intl.formatMessage(messages.keywords)}
                  </label>
                  <div className="form-input-area">
                    <div className="form-input-field">
                      <KeywordSelector
                        defaultValue={values.keywords}
                        isMulti
                        isDisabled={!isValidated || isTesting}
                        onChange={(value) => {
                          setFieldValue(
                            'keywords',
                            value?.map((v) => v.value).join(',')
                          );
                        }}
                      />
                    </div>
                    {errors.keywords &&
                      touched.keywords &&
                      typeof errors.keywords === 'string' && (
                        <div className="error">{errors.keywords}</div>
                      )}
                  </div>
                </div>
                {values.sonarrServiceId != null && (
                  <div className="form-row">
                    <label htmlFor="seriesType" className="text-label">
                      {intl.formatMessage(messages.seriesType)}
                    </label>
                    <div className="form-input-area">
                      <Select<OptionType, true>
                        options={[
                          {
                            value: 1,
                            label: intl.formatMessage(messages.anime),
                          },
                          {
                            value: 2,
                            label: intl.formatMessage(messages.standard),
                          },
                          {
                            value: 3,
                            label: intl.formatMessage(messages.daily),
                          },
                        ]}
                        isMulti
                        isDisabled={!isValidated || isTesting}
                        placeholder={intl.formatMessage(messages.seriesType)}
                        className="react-select-container"
                        classNamePrefix="react-select"
                        value={
                          values.seriesType
                            ?.split(',')
                            .map((type) => {
                              const typeMap: Record<
                                string,
                                { value: number; label: string }
                              > = {
                                anime: {
                                  value: 1,
                                  label: intl.formatMessage(messages.anime),
                                },
                                standard: {
                                  value: 2,
                                  label: intl.formatMessage(messages.standard),
                                },
                                daily: {
                                  value: 3,
                                  label: intl.formatMessage(messages.daily),
                                },
                              };
                              return typeMap[type.trim()];
                            })
                            .filter((v): v is OptionType => v !== undefined) ||
                          []
                        }
                        onChange={(value) => {
                          const valueMap: Record<number, string> = {
                            1: 'anime',
                            2: 'standard',
                            3: 'daily',
                          };
                          setFieldValue(
                            'seriesType',
                            value.map((v) => valueMap[v.value]).join(',')
                          );
                        }}
                      />
                      <p className="mt-1 text-xs text-gray-500">
                        {intl.formatMessage(messages.seriesTypeDescription)}
                      </p>
                    </div>
                  </div>
                )}
                <h3 className="mt-4 text-lg font-bold leading-8 text-gray-100">
                  {intl.formatMessage(messages.settings)}
                </h3>
                <p className="description">
                  {intl.formatMessage(messages.settingsDescription)}
                </p>
                {(values.radarrServiceId != null ||
                  values.sonarrServiceId != null) && (
                  <div className="form-row">
                    <label htmlFor="targetServerId" className="text-label">
                      {intl.formatMessage(messages.targetServer)}
                    </label>
                    <div className="form-input-area">
                      <div className="form-input-field">
                        <select
                          id="targetServerId"
                          name="targetServerId"
                          value={values.targetServerId ?? ''}
                          disabled={!isValidated || isTesting}
                          onChange={(e) => {
                            const val = e.target.value
                              ? Number(e.target.value)
                              : undefined;
                            setFieldValue('targetServerId', val ?? null);
                            if (val != null) {
                              const type =
                                values.sonarrServiceId != null
                                  ? 'sonarr'
                                  : 'radarr';
                              getTargetServiceInfos(val, type);
                            } else {
                              setTargetTestResponse(null);
                            }
                          }}
                        >
                          <option value="">—</option>
                          {values.sonarrServiceId != null
                            ? sonarrServices
                                .filter((s) => s.id !== values.sonarrServiceId)
                                .map((s) => (
                                  <option
                                    key={`target-sonarr-${s.id}`}
                                    value={s.id}
                                  >
                                    {s.name}
                                  </option>
                                ))
                            : radarrServices
                                .filter((s) => s.id !== values.radarrServiceId)
                                .map((s) => (
                                  <option
                                    key={`target-radarr-${s.id}`}
                                    value={s.id}
                                  >
                                    {s.name}
                                  </option>
                                ))}
                        </select>
                      </div>
                      <p className="mt-1 text-xs text-gray-500">
                        {intl.formatMessage(messages.targetServerDescription)}
                      </p>
                    </div>
                  </div>
                )}
                <div className="form-row">
                  <label htmlFor="rootFolderRule" className="text-label">
                    {intl.formatMessage(messages.rootfolder)}
                  </label>
                  <div className="form-input-area">
                    <div className="form-input-field">
                      <Field
                        as="select"
                        id="rootFolderRule"
                        name="rootFolder"
                        disabled={!isValidated || isTesting || isLoadingTarget}
                      >
                        <option value="">
                          {intl.formatMessage(messages.selectRootFolder)}
                        </option>
                        {activeTestResponse.rootFolders.length > 0 &&
                          activeTestResponse.rootFolders.map((folder) => (
                            <option
                              key={`loaded-profile-${folder.id}`}
                              value={folder.path}
                            >
                              {folder.path}
                            </option>
                          ))}
                      </Field>
                    </div>
                    {errors.rootFolder &&
                      touched.rootFolder &&
                      typeof errors.rootFolder === 'string' && (
                        <div className="error">{errors.rootFolder}</div>
                      )}
                  </div>
                </div>
                <div className="form-row">
                  <label htmlFor="profileIdRule" className="text-label">
                    {intl.formatMessage(messages.qualityprofile)}
                  </label>
                  <div className="form-input-area">
                    <div className="form-input-field">
                      <Field
                        as="select"
                        id="profileIdRule"
                        name="profileId"
                        disabled={!isValidated || isTesting || isLoadingTarget}
                      >
                        <option value="">
                          {intl.formatMessage(messages.selectQualityProfile)}
                        </option>
                        {activeTestResponse.profiles.length > 0 &&
                          activeTestResponse.profiles.map((profile) => (
                            <option
                              key={`loaded-profile-${profile.id}`}
                              value={profile.id}
                            >
                              {profile.name}
                            </option>
                          ))}
                      </Field>
                    </div>
                    {errors.profileId &&
                      touched.profileId &&
                      typeof errors.profileId === 'string' && (
                        <div className="error">{errors.profileId}</div>
                      )}
                  </div>
                </div>
                <div className="form-row">
                  <label htmlFor="tags" className="text-label">
                    {intl.formatMessage(messages.tags)}
                  </label>
                  <div className="form-input-area">
                    <Select<OptionType, true>
                      options={activeTestResponse.tags.map((tag) => ({
                        label: tag.label,
                        value: tag.id,
                      }))}
                      isMulti
                      isDisabled={!isValidated || isTesting || isLoadingTarget}
                      placeholder={intl.formatMessage(messages.selecttags)}
                      className="react-select-container"
                      classNamePrefix="react-select"
                      value={
                        (values?.tags
                          ?.split(',')
                          .map((tagId) => {
                            const foundTag = activeTestResponse.tags.find(
                              (tag) => tag.id === Number(tagId)
                            );

                            if (!foundTag) {
                              return undefined;
                            }

                            return {
                              value: foundTag.id,
                              label: foundTag.label,
                            };
                          })
                          .filter(
                            (option) => option !== undefined
                          ) as OptionType[]) || []
                      }
                      onChange={(value) => {
                        setFieldValue(
                          'tags',
                          value.map((option) => option.value).join(',')
                        );
                      }}
                      noOptionsMessage={() =>
                        intl.formatMessage(messages.notagoptions)
                      }
                    />
                  </div>
                </div>
              </div>
            </Modal>
          );
        }}
      </Formik>
    </Transition>
  );
};

export default OverrideRuleModal;
