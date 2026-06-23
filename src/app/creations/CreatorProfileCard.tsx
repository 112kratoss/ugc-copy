'use client';

import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';
import Link from 'next/link';
import { AtSign, BadgeCheck, CheckCircle2, ExternalLink, Loader2, Save, UserRound, Camera, ImagePlus } from 'lucide-react';

import type { EditableCreatorProfile, ProfileFieldErrors, ProfileUpdatePayload } from '@/lib/profile';
import { uploadProfileMediaWithSignedIntent } from '@/lib/profile-media-upload';
import { supabase } from '@/lib/supabase';

interface CreatorProfileCardProps {
  initialProfile: EditableCreatorProfile | null;
  isLoading: boolean;
  loadError: string | null;
  onProfileSaved?: (profile: EditableCreatorProfile) => void;
  isEmbedded?: boolean;
  onboardingMode?: boolean;
}

const EMPTY_ERRORS: ProfileFieldErrors = {};
const MAX_PROFILE_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_BIO_LENGTH = 280;
const AVATAR_CROP_SIZE = 512;
const COVER_CROP_WIDTH = 1600;
const COVER_CROP_HEIGHT = 360;
const MIN_AVATAR_ZOOM = 1;
const MAX_AVATAR_ZOOM = 3;
const DEFAULT_AVATAR_CROP = {
  x: 50,
  y: 28,
  zoom: 1.35,
};
const DEFAULT_COVER_CROP = {
  x: 50,
  y: 50,
  zoom: 1,
};

type MediaCrop = typeof DEFAULT_AVATAR_CROP;
type MediaDragState = {
  pointerId: number;
  startX: number;
  startY: number;
  cropStartX: number;
  cropStartY: number;
  frameWidth: number;
  frameHeight: number;
};

function clampPercent(value: number) {
  return Math.min(100, Math.max(0, value));
}

function clampZoom(value: number) {
  return Math.min(MAX_AVATAR_ZOOM, Math.max(MIN_AVATAR_ZOOM, Number(value.toFixed(2))));
}

function buildProfilePayload(
  form: EditableCreatorProfile,
  overrides?: Partial<Pick<EditableCreatorProfile, 'avatarUrl' | 'coverUrl'>>
): ProfileUpdatePayload {
  return {
    username: form.username,
    displayName: form.displayName,
    bio: form.bio,
    avatarUrl: overrides?.avatarUrl ?? form.avatarUrl,
    coverUrl: overrides?.coverUrl ?? form.coverUrl,
    twitterHandle: form.twitterHandle,
    instagramHandle: form.instagramHandle,
    tiktokHandle: form.tiktokHandle,
  };
}

function getMediaObjectStyle(crop: MediaCrop): CSSProperties {
  return {
    objectPosition: `${crop.x}% ${crop.y}%`,
    transform: `scale(${crop.zoom})`,
  };
}

async function loadImage(file: File): Promise<HTMLImageElement> {
  const imageUrl = URL.createObjectURL(file);

  try {
    const image = new Image();
    image.decoding = 'async';
    image.src = imageUrl;
    await image.decode();
    return image;
  } finally {
    URL.revokeObjectURL(imageUrl);
  }
}

async function buildCroppedImageFile({
  file,
  crop,
  width,
  height,
  fileName,
}: {
  file: File;
  crop: MediaCrop;
  width: number;
  height: number;
  fileName: string;
}): Promise<File> {
  const image = await loadImage(file);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');

  if (!context) {
    return file;
  }

  const baseScale = Math.max(
    width / image.naturalWidth,
    height / image.naturalHeight
  );
  const scale = baseScale * crop.zoom;
  const drawWidth = image.naturalWidth * scale;
  const drawHeight = image.naturalHeight * scale;
  const drawX = -(drawWidth - width) * (crop.x / 100);
  const drawY = -(drawHeight - height) * (crop.y / 100);

  context.clearRect(0, 0, width, height);
  context.drawImage(image, drawX, drawY, drawWidth, drawHeight);

  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, 'image/png');
  });

  if (!blob) {
    return file;
  }

  return new File([blob], fileName, { type: 'image/png' });
}

async function buildCroppedAvatarFile(file: File, crop: MediaCrop): Promise<File> {
  return buildCroppedImageFile({
    file,
    crop,
    width: AVATAR_CROP_SIZE,
    height: AVATAR_CROP_SIZE,
    fileName: 'avatar-crop.png',
  });
}

async function buildCroppedCoverFile(file: File, crop: MediaCrop): Promise<File> {
  return buildCroppedImageFile({
    file,
    crop,
    width: COVER_CROP_WIDTH,
    height: COVER_CROP_HEIGHT,
    fileName: 'cover-crop.png',
  });
}

export default function CreatorProfileCard({
  initialProfile,
  isLoading,
  loadError,
  onProfileSaved,
  isEmbedded = false,
  onboardingMode = false,
}: CreatorProfileCardProps) {
  const [form, setForm] = useState<EditableCreatorProfile | null>(initialProfile);
  const [fieldErrors, setFieldErrors] = useState<ProfileFieldErrors>(EMPTY_ERRORS);
  const [formError, setFormError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [coverFile, setCoverFile] = useState<File | null>(null);
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null);
  const [coverPreview, setCoverPreview] = useState<string | null>(null);
  const [avatarCrop, setAvatarCrop] = useState<MediaCrop>(DEFAULT_AVATAR_CROP);
  const [coverCrop, setCoverCrop] = useState<MediaCrop>(DEFAULT_COVER_CROP);
  const avatarDragState = useRef<MediaDragState | null>(null);
  const coverDragState = useRef<MediaDragState | null>(null);
  const avatarCropControlRef = useRef<HTMLButtonElement | null>(null);
  const coverCropControlRef = useRef<HTMLButtonElement | null>(null);

  const validateProfileImage = (file: File, field: 'avatarUrl' | 'coverUrl') => {
    if (!file.type.startsWith('image/')) {
      setFieldErrors((current) => ({
        ...current,
        [field]: 'Upload an image file.',
      }));
      return false;
    }

    if (file.size > MAX_PROFILE_IMAGE_BYTES) {
      setFieldErrors((current) => ({
        ...current,
        [field]: 'Use an image smaller than 5MB.',
      }));
      return false;
    }

    return true;
  };

  const handleAvatarChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file && validateProfileImage(file, 'avatarUrl')) {
      setAvatarFile(file);
      setAvatarCrop(DEFAULT_AVATAR_CROP);
      setAvatarPreview((current) => {
        if (current) {
          URL.revokeObjectURL(current);
        }

        return URL.createObjectURL(file);
      });
      setFieldErrors((c) => ({ ...c, avatarUrl: undefined }));
    }
  };

  const handleCoverChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file && validateProfileImage(file, 'coverUrl')) {
      setCoverFile(file);
      setCoverCrop(DEFAULT_COVER_CROP);
      setCoverPreview((current) => {
        if (current) {
          URL.revokeObjectURL(current);
        }

        return URL.createObjectURL(file);
      });
      setFieldErrors((c) => ({ ...c, coverUrl: undefined }));
    }
  };

  const handleAvatarDragStart = (event: PointerEvent<HTMLButtonElement>) => {
    if (!avatarPreview) {
      return;
    }

    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    avatarDragState.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      cropStartX: avatarCrop.x,
      cropStartY: avatarCrop.y,
      frameWidth: Math.max(1, rect.width),
      frameHeight: Math.max(1, rect.height),
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handleAvatarDragMove = (event: PointerEvent<HTMLButtonElement>) => {
    const drag = avatarDragState.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }

    const deltaX = ((event.clientX - drag.startX) / drag.frameWidth) * (100 / Math.max(1, avatarCrop.zoom));
    const deltaY = ((event.clientY - drag.startY) / drag.frameHeight) * (100 / Math.max(1, avatarCrop.zoom));
    setAvatarCrop((current) => ({
      ...current,
      x: clampPercent(drag.cropStartX - deltaX),
      y: clampPercent(drag.cropStartY - deltaY),
    }));
  };

  const handleAvatarDragEnd = (event: PointerEvent<HTMLButtonElement>) => {
    if (avatarDragState.current?.pointerId === event.pointerId) {
      avatarDragState.current = null;
    }

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const handleAvatarKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const moveStep = 2.5;
    const zoomStep = 0.08;

    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight' || event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
      setAvatarCrop((current) => ({
        ...current,
        x:
          event.key === 'ArrowLeft'
            ? clampPercent(current.x + moveStep)
            : event.key === 'ArrowRight'
              ? clampPercent(current.x - moveStep)
              : current.x,
        y:
          event.key === 'ArrowUp'
            ? clampPercent(current.y + moveStep)
            : event.key === 'ArrowDown'
              ? clampPercent(current.y - moveStep)
              : current.y,
      }));
      return;
    }

    if (event.key === '+' || event.key === '=' || event.key === '-') {
      event.preventDefault();
      setAvatarCrop((current) => ({
        ...current,
        zoom: clampZoom(current.zoom + (event.key === '-' ? -zoomStep : zoomStep)),
      }));
    }
  };

  const handleCoverDragStart = (event: PointerEvent<HTMLButtonElement>) => {
    if (!coverPreview) {
      return;
    }

    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    coverDragState.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      cropStartX: coverCrop.x,
      cropStartY: coverCrop.y,
      frameWidth: Math.max(1, rect.width),
      frameHeight: Math.max(1, rect.height),
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handleCoverDragMove = (event: PointerEvent<HTMLButtonElement>) => {
    const drag = coverDragState.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }

    const deltaX = ((event.clientX - drag.startX) / drag.frameWidth) * (100 / Math.max(1, coverCrop.zoom));
    const deltaY = ((event.clientY - drag.startY) / drag.frameHeight) * (100 / Math.max(1, coverCrop.zoom));
    setCoverCrop((current) => ({
      ...current,
      x: clampPercent(drag.cropStartX - deltaX),
      y: clampPercent(drag.cropStartY - deltaY),
    }));
  };

  const handleCoverDragEnd = (event: PointerEvent<HTMLButtonElement>) => {
    if (coverDragState.current?.pointerId === event.pointerId) {
      coverDragState.current = null;
    }

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const handleCoverKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!coverPreview) {
      return;
    }

    const moveStep = 2.5;
    const zoomStep = 0.08;

    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight' || event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
      setCoverCrop((current) => ({
        ...current,
        x:
          event.key === 'ArrowLeft'
            ? clampPercent(current.x + moveStep)
            : event.key === 'ArrowRight'
              ? clampPercent(current.x - moveStep)
              : current.x,
        y:
          event.key === 'ArrowUp'
            ? clampPercent(current.y + moveStep)
            : event.key === 'ArrowDown'
              ? clampPercent(current.y - moveStep)
              : current.y,
      }));
      return;
    }

    if (event.key === '+' || event.key === '=' || event.key === '-') {
      event.preventDefault();
      setCoverCrop((current) => ({
        ...current,
        zoom: clampZoom(current.zoom + (event.key === '-' ? -zoomStep : zoomStep)),
      }));
    }
  };

  useEffect(() => {
    setForm(initialProfile);
    setFieldErrors(EMPTY_ERRORS);
    setFormError(null);
  }, [initialProfile]);

  useEffect(() => {
    return () => {
      if (avatarPreview) {
        URL.revokeObjectURL(avatarPreview);
      }
    };
  }, [avatarPreview]);

  useEffect(() => {
    return () => {
      if (coverPreview) {
        URL.revokeObjectURL(coverPreview);
      }
    };
  }, [coverPreview]);

  useEffect(() => {
    const cropControl = avatarCropControlRef.current;
    if (!cropControl || !avatarPreview) {
      return;
    }

    const handleWheel = (event: globalThis.WheelEvent) => {
      event.preventDefault();
      const zoomDelta = event.deltaY > 0 ? -0.08 : 0.08;
      setAvatarCrop((current) => ({
        ...current,
        zoom: clampZoom(current.zoom + zoomDelta),
      }));
    };

    cropControl.addEventListener('wheel', handleWheel, { passive: false });
    return () => {
      cropControl.removeEventListener('wheel', handleWheel);
    };
  }, [avatarPreview]);

  useEffect(() => {
    const cropControl = coverCropControlRef.current;
    if (!cropControl || !coverPreview) {
      return;
    }

    const handleWheel = (event: globalThis.WheelEvent) => {
      event.preventDefault();
      const zoomDelta = event.deltaY > 0 ? -0.08 : 0.08;
      setCoverCrop((current) => ({
        ...current,
        zoom: clampZoom(current.zoom + zoomDelta),
      }));
    };

    cropControl.addEventListener('wheel', handleWheel, { passive: false });
    return () => {
      cropControl.removeEventListener('wheel', handleWheel);
    };
  }, [coverPreview]);

  const updateField = (key: keyof EditableCreatorProfile, value: string) => {
    setForm((current) => {
      if (!current) {
        return current;
      }

      return {
        ...current,
        [key]: value,
      };
    });

    setFieldErrors((current) => ({
      ...current,
      [key]: undefined,
    }));
    setFormError(null);
    setSuccessMessage(null);
  };

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!form || isSaving) {
      return;
    }

    setIsSaving(true);
    setFieldErrors(EMPTY_ERRORS);
    setFormError(null);
    setSuccessMessage(null);
    const uploadedStoragePaths: string[] = [];
    let cleanupAccessToken: string | null = null;

    const cleanupUploadedMedia = async () => {
      if (uploadedStoragePaths.length === 0) {
        return;
      }

      if (!cleanupAccessToken) {
        return;
      }

      try {
        const cleanupResponse = await fetch('/api/profile/media/cleanup', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${cleanupAccessToken}`,
          },
          body: JSON.stringify({ paths: uploadedStoragePaths }),
        });

        if (!cleanupResponse.ok) {
          const cleanupData = await cleanupResponse.json().catch(() => null) as { error?: string } | null;
          throw new Error(cleanupData?.error || 'Profile media cleanup failed.');
        }
      } catch (cleanupError) {
        console.error('Failed to clean up uploaded profile media:', cleanupError);
      }
    };

    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (!session?.access_token) {
        setFormError('Please log in again to update your profile.');
        return;
      }
      cleanupAccessToken = session.access_token;

      const validationResponse = await fetch('/api/profile/validate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify(buildProfilePayload(form)),
      });
      const validationData = await validationResponse.json();
      if (!validationResponse.ok) {
        if (validationData.fieldErrors) {
          setFieldErrors(validationData.fieldErrors as ProfileFieldErrors);
        }

        setFormError(validationData.error || 'Failed to validate profile.');
        return;
      }

      let finalAvatarUrl = form.avatarUrl;
      let finalCoverUrl = form.coverUrl;

      if (avatarFile || coverFile) {
        setSuccessMessage('Uploading new media...');
      }

      if (avatarFile) {
        const uploadFile = await buildCroppedAvatarFile(avatarFile, avatarCrop).catch(() => avatarFile);
        const upload = await uploadProfileMediaWithSignedIntent({
          accessToken: session.access_token,
          file: uploadFile,
          role: 'avatar',
        });
        uploadedStoragePaths.push(upload.storagePath);
        finalAvatarUrl = upload.publicUrl;
      }

      if (coverFile) {
        const uploadFile = await buildCroppedCoverFile(coverFile, coverCrop).catch(() => coverFile);
        const upload = await uploadProfileMediaWithSignedIntent({
          accessToken: session.access_token,
          file: uploadFile,
          role: 'cover',
        });
        uploadedStoragePaths.push(upload.storagePath);
        finalCoverUrl = upload.publicUrl;
      }

      if (avatarFile || coverFile) {
        setSuccessMessage('Saving profile data...');
      }

      const response = await fetch('/api/profile', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify(
          buildProfilePayload(form, {
            avatarUrl: finalAvatarUrl,
            coverUrl: finalCoverUrl,
          })
        ),
      });

      const data = await response.json();
      if (!response.ok) {
        await cleanupUploadedMedia();
        if (data.fieldErrors) {
          setFieldErrors(data.fieldErrors as ProfileFieldErrors);
        }

        setFormError(data.error || 'Failed to update profile.');
        return;
      }

      const nextProfile: EditableCreatorProfile = {
        id: data.id,
        username: data.username ?? '',
        displayName: data.displayName ?? '',
        bio: data.bio ?? '',
        avatarUrl: data.avatarUrl ?? '',
        coverUrl: data.coverUrl ?? '',
        websiteUrl: data.websiteUrl ?? '',
        twitterHandle: data.twitterHandle ?? '',
        instagramHandle: data.instagramHandle ?? '',
        tiktokHandle: data.tiktokHandle ?? '',
        location: data.location ?? '',
        credits: data.credits ?? form.credits,
      };

      setAvatarFile(null);
      setCoverFile(null);
      setAvatarPreview((current) => {
        if (current) {
          URL.revokeObjectURL(current);
        }

        return null;
      });
      setCoverPreview((current) => {
        if (current) {
          URL.revokeObjectURL(current);
        }

        return null;
      });
      setForm(nextProfile);
      setSuccessMessage(onboardingMode ? 'Creator profile saved. Your public profile is ready.' : 'Creator profile updated.');
      onProfileSaved?.(nextProfile);
    } catch (error) {
      await cleanupUploadedMedia();
      console.error('Failed to update profile:', error);
      setFormError('Failed to update profile.');
    } finally {
      setIsSaving(false);
    }
  };

  if (isLoading) {
    return (
      <div className="mb-8 rounded-3xl border border-white/5 bg-zinc-900/30 p-6 backdrop-blur-sm">
        <div className="h-6 w-48 animate-pulse rounded bg-white/10" />
        <div className="mt-3 h-4 w-80 animate-pulse rounded bg-white/5" />
        <div className="mt-6 grid gap-4 md:grid-cols-2">
          <div className="h-12 animate-pulse rounded-2xl bg-black/40" />
          <div className="h-12 animate-pulse rounded-2xl bg-black/40" />
          <div className="h-24 animate-pulse rounded-2xl bg-black/40 md:col-span-2" />
        </div>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="mb-8 rounded-3xl border border-red-500/20 bg-red-500/5 p-6 text-sm text-red-200">
        {loadError}
      </div>
    );
  }

  if (!form) {
    return null;
  }

  const normalizedUsername = form.username.trim().replace(/^@+/, '').toLowerCase();
  const previewHref = normalizedUsername.length > 0 ? `/creators/${normalizedUsername}` : null;
  const avatarPreviewStyle = avatarPreview ? getMediaObjectStyle(avatarCrop) : undefined;
  const coverPreviewStyle = coverPreview ? getMediaObjectStyle(coverCrop) : undefined;
  const hasDisplayIdentity = Boolean(form.displayName.trim());
  const hasProfileStory = Boolean(form.bio.trim());
  const hasProfileMedia = Boolean(avatarPreview || coverPreview || form.avatarUrl || form.coverUrl);
  const onboardingTasks = [
    { label: 'Handle', done: Boolean(normalizedUsername) },
    { label: 'Name', done: hasDisplayIdentity },
    { label: 'Bio', done: hasProfileStory },
    { label: 'Image', done: hasProfileMedia },
  ];
  const completedTaskCount = onboardingTasks.filter((task) => task.done).length;

  return (
    <section className="space-y-6">
      {!isEmbedded && (
        <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between rounded-3xl border border-white/5 bg-zinc-900/40 p-6 backdrop-blur-md shadow-xl">
          <div>
            <div className="flex items-center gap-3">
              <div className="rounded-2xl border border-purple-500/20 bg-purple-500/10 p-3 text-purple-300">
                <UserRound className="h-5 w-5" />
              </div>
              <div>
                <h2 className="text-xl font-semibold text-white">Creator Profile</h2>
                <p className="mt-1 max-w-2xl text-sm text-zinc-400">
                  Claim your public identity so every showcase post points back to you, not just the output.
                </p>
              </div>
            </div>
          </div>

          {previewHref ? (
            <Link
              href={previewHref}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-black/40 px-4 py-2 text-sm font-medium text-zinc-200 transition-colors hover:border-white/20 hover:text-white"
            >
              Preview profile
              <ExternalLink className="h-4 w-4" />
            </Link>
          ) : (
            <span className="inline-flex items-center gap-2 rounded-full border border-white/5 bg-black/20 px-4 py-2 text-sm text-zinc-500">
              Add a username to unlock your public profile
            </span>
          )}
        </div>
      )}

      {onboardingMode ? (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,0.95fr)_minmax(300px,0.55fr)]">
          <div className="rounded-[28px] border border-white/8 bg-zinc-950/70 p-5">
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.2em] text-sky-200/80">
              <BadgeCheck className="h-4 w-4" />
              Setup progress
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              {onboardingTasks.map((task) => (
                <span
                  key={task.label}
                  className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm ${
                    task.done
                      ? 'border-emerald-300/20 bg-emerald-500/10 text-emerald-50'
                      : 'border-white/10 bg-white/[0.03] text-zinc-300'
                  }`}
                >
                  <CheckCircle2 className={`h-3.5 w-3.5 ${task.done ? 'text-emerald-300' : 'text-zinc-500'}`} />
                  {task.label}
                </span>
              ))}
            </div>
            <p className="mt-4 text-sm leading-7 text-zinc-400">
              {completedTaskCount === onboardingTasks.length
                ? 'Profile setup looks ready. Save it, then publish or share your first post.'
                : 'Save the handle first. A name, short bio, and image make the public profile easier to trust.'}
            </p>
          </div>

          <div className="rounded-[28px] border border-white/8 bg-[linear-gradient(180deg,rgba(14,18,25,0.96),rgba(7,9,12,0.98))] p-5">
            <div className="text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500">Public preview</div>
            <div className="mt-4 overflow-hidden rounded-[22px] border border-white/8 bg-black/35">
              <div className="h-20 bg-[radial-gradient(circle_at_top_left,rgba(56,189,248,0.28),transparent_42%),linear-gradient(135deg,rgba(16,185,129,0.16),rgba(59,130,246,0.1))]">
                {(coverPreview || form.coverUrl) ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={coverPreview || form.coverUrl}
                    alt=""
                    className="h-full w-full object-cover"
                    style={coverPreviewStyle}
                  />
                ) : null}
              </div>
              <div className="px-4 pb-4">
                <div className="-mt-7 h-14 w-14 overflow-hidden rounded-full border border-white/15 bg-zinc-950">
                  {(avatarPreview || form.avatarUrl) ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={avatarPreview || form.avatarUrl}
                      alt=""
                      className="h-full w-full object-cover"
                      style={avatarPreviewStyle}
                    />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center text-zinc-500">
                      <UserRound className="h-6 w-6" />
                    </div>
                  )}
                </div>
                <div className="mt-3 text-sm font-semibold text-white">{form.displayName.trim() || 'Creator name'}</div>
                <div className="mt-1 text-xs text-zinc-500">@{normalizedUsername || 'creator-name'}</div>
                <p className="mt-3 line-clamp-2 text-xs leading-5 text-zinc-400">
                  {form.bio.trim() || 'A short creator bio will appear here.'}
                </p>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      <form id="creator-profile-form" onSubmit={handleSubmit} className="space-y-6">
        {/* Profile Identity Section */}
        <div className="rounded-3xl border border-white/5 bg-zinc-900/40 p-6 backdrop-blur-md shadow-xl">
          <div className="mb-6 flex flex-col gap-1">
            <h3 className="text-lg font-semibold text-white">Profile Identity</h3>
            <p className="text-sm text-zinc-400">Manage your basic information, avatar, and cover banner.</p>
          </div>

          <div className="grid gap-6 md:grid-cols-2">
            {/* Live Media Pickers */}
            <div className="md:col-span-2 grid gap-6 sm:grid-cols-2">
              {/* Avatar Picker */}
              <div className="space-y-4">
                <span className="block text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500">Avatar Image</span>
                <div className="flex items-center gap-6">
                  <div className="h-20 w-20 shrink-0 overflow-hidden rounded-full border border-white/10 bg-black/50 shadow-inner">
                    {(avatarPreview || form.avatarUrl) ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={avatarPreview || form.avatarUrl}
                        alt="Avatar preview"
                        className="h-full w-full object-cover"
                        style={avatarPreviewStyle}
                      />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center text-zinc-600">
                        <UserRound className="h-8 w-8" />
                      </div>
                    )}
                  </div>
                  <label className="group relative flex cursor-pointer items-center justify-center gap-2 rounded-2xl border border-white/10 bg-black/40 px-5 py-3 text-sm font-medium text-white transition-all hover:bg-black/60 hover:border-purple-500/50">
                    <Camera className="h-4 w-4 text-purple-400 group-hover:scale-110 transition-transform" />
                    <span>Upload image</span>
                    <input
                      type="file"
                      accept="image/*"
                      onChange={handleAvatarChange}
                      className="hidden"
                    />
                  </label>
                </div>
                {fieldErrors.avatarUrl ? <p className="mt-2 text-xs text-red-300">{fieldErrors.avatarUrl}</p> : null}
              </div>

              {avatarPreview ? (
                <div className="rounded-[24px] border border-sky-300/15 bg-sky-500/[0.06] p-4 sm:col-span-2">
                  <div className="flex flex-col gap-5 lg:flex-row lg:items-center">
                    <div className="mx-auto w-full max-w-[220px] shrink-0 lg:mx-0">
                      <button
                        type="button"
                        ref={avatarCropControlRef}
                        aria-label="Drag avatar image to position the face. Scroll to zoom."
                        className="relative mx-auto h-40 w-40 touch-none cursor-grab overflow-hidden rounded-full border border-white/15 bg-black/50 shadow-inner transition active:cursor-grabbing focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-sky-300"
                        onPointerDown={handleAvatarDragStart}
                        onPointerMove={handleAvatarDragMove}
                        onPointerUp={handleAvatarDragEnd}
                        onPointerCancel={handleAvatarDragEnd}
                        onKeyDown={handleAvatarKeyDown}
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={avatarPreview}
                          alt="Cropped avatar preview"
                          className="h-full w-full select-none object-cover"
                          draggable={false}
                          style={avatarPreviewStyle}
                        />
                        <div className="pointer-events-none absolute inset-0 rounded-full ring-2 ring-sky-200/45 ring-inset" />
                        <div className="pointer-events-none absolute inset-x-10 top-1/2 border-t border-white/20" />
                        <div className="pointer-events-none absolute inset-y-10 left-1/2 border-l border-white/20" />
                      </button>
                      <p className="mt-3 text-center text-xs text-zinc-500">Drag to position. Scroll to zoom.</p>
                    </div>
                    <div className="min-w-0 flex-1">
                      <div>
                        <div className="text-sm font-semibold text-white">Frame your face</div>
                        <p className="mt-1 text-xs leading-5 text-zinc-400">
                          Move and scale the image directly inside the circle until the face sits clearly in frame.
                        </p>
                      </div>
                    </div>
                  </div>
                </div>
              ) : null}

              {/* Cover Banner Picker */}
              <div className="space-y-4">
                <span className="block text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500">Cover Banner</span>
                <div className="flex flex-col gap-4">
                  <div className="group relative">
                    <button
                      type="button"
                      ref={coverCropControlRef}
                      aria-label={coverPreview ? 'Drag cover image to position it. Scroll to zoom.' : 'Cover banner preview'}
                      className={`relative h-32 w-full shrink-0 overflow-hidden rounded-2xl border border-white/10 bg-black/50 shadow-inner transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-sky-300 sm:h-40 ${
                        coverPreview ? 'touch-none cursor-grab active:cursor-grabbing' : 'cursor-default'
                      }`}
                      onPointerDown={handleCoverDragStart}
                      onPointerMove={handleCoverDragMove}
                      onPointerUp={handleCoverDragEnd}
                      onPointerCancel={handleCoverDragEnd}
                      onKeyDown={handleCoverKeyDown}
                    >
                      {(coverPreview || form.coverUrl) ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={coverPreview || form.coverUrl}
                          alt="Cover preview"
                          className="h-full w-full select-none object-cover"
                          draggable={false}
                          style={coverPreviewStyle}
                        />
                      ) : (
                        <div className="flex h-full w-full items-center justify-center text-zinc-600">
                          <ImagePlus className="h-8 w-8" />
                        </div>
                      )}
                      {coverPreview ? (
                        <>
                          <div className="pointer-events-none absolute inset-0 ring-2 ring-sky-200/35 ring-inset" />
                          <div className="pointer-events-none absolute inset-x-0 top-1/2 border-t border-white/20" />
                          <div className="pointer-events-none absolute inset-y-0 left-1/2 border-l border-white/20" />
                        </>
                      ) : null}
                    </button>
                    <label className="absolute bottom-3 right-3 z-10 flex cursor-pointer items-center justify-center">
                      <div className="flex items-center gap-2 rounded-full border border-white/20 bg-black/70 px-4 py-2 text-sm font-medium text-white shadow-lg backdrop-blur-md transition-colors hover:bg-white/10">
                        <Camera className="h-4 w-4 text-pink-400" />
                        <span>{coverPreview || form.coverUrl ? 'Change cover' : 'Upload cover'}</span>
                      </div>
                      <input
                        type="file"
                        accept="image/*"
                        onChange={handleCoverChange}
                        className="hidden"
                      />
                    </label>
                  </div>
                  {coverPreview ? (
                    <p className="text-xs leading-5 text-zinc-500">Drag the cover to position it. Scroll over the banner to zoom.</p>
                  ) : null}
                </div>
                {fieldErrors.coverUrl ? <p className="mt-2 text-xs text-red-300">{fieldErrors.coverUrl}</p> : null}
              </div>
            </div>

            <label className="block">
              <span className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500">
                <AtSign className="h-3.5 w-3.5" />
                Username <span className="text-sky-300">Required</span>
              </span>
              <input
                type="text"
                value={form.username || ''}
                onChange={(event) => updateField('username', event.target.value)}
                placeholder="creator-name"
                required
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                className="w-full rounded-2xl border border-white/10 bg-black/40 px-4 py-3 text-white outline-none transition-colors focus:border-purple-500/50"
                autoComplete="off"
                aria-invalid={Boolean(fieldErrors.username)}
              />
              <p className="mt-2 text-xs leading-5 text-zinc-500">
                {previewHref ? `Public URL: ${previewHref}` : 'Use 3-24 lowercase letters, numbers, or hyphens.'}
              </p>
              {fieldErrors.username ? <p className="mt-2 text-xs text-red-300">{fieldErrors.username}</p> : null}
            </label>

            <label className="block">
              <span className="mb-2 block text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500">
                Display Name
              </span>
              <input
                type="text"
                value={form.displayName || ''}
                onChange={(event) => updateField('displayName', event.target.value)}
                placeholder="Your creator name"
                className="w-full rounded-2xl border border-white/10 bg-black/40 px-4 py-3 text-white outline-none transition-colors focus:border-purple-500/50"
              />
              {fieldErrors.displayName ? <p className="mt-2 text-xs text-red-300">{fieldErrors.displayName}</p> : null}
            </label>

            <label className="block md:col-span-2">
              <span className="mb-2 block text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500">
                Bio
              </span>
              <textarea
                value={form.bio || ''}
                onChange={(event) => updateField('bio', event.target.value)}
                placeholder="What kind of UGC creator are you?"
                rows={3}
                maxLength={MAX_BIO_LENGTH}
                className="w-full rounded-2xl border border-white/10 bg-black/40 px-4 py-3 text-white outline-none transition-colors focus:border-purple-500/50"
              />
              <div className="mt-2 flex justify-end text-xs text-zinc-500">
                {form.bio.length}/{MAX_BIO_LENGTH}
              </div>
              {fieldErrors.bio ? <p className="mt-2 text-xs text-red-300">{fieldErrors.bio}</p> : null}
            </label>
          </div>
        </div>

        {/* Social Links Section */}
        <div className="rounded-3xl border border-white/5 bg-zinc-900/40 p-6 backdrop-blur-md shadow-xl">
          <div className="mb-6 flex flex-col gap-1">
            <h3 className="text-lg font-semibold text-white">Social Links</h3>
            <p className="text-sm text-zinc-400">Add the handles buyers already use to recognize you.</p>
          </div>

          <div className="grid gap-6 md:grid-cols-2">
            <label className="block">
              <span className="mb-2 block text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500">
                X (Twitter) Handle
              </span>
              <div className="relative">
                <span className="absolute left-4 top-3.5 text-zinc-500">@</span>
                <input
                  type="text"
                  value={form.twitterHandle || ''}
                  onChange={(event) => updateField('twitterHandle', event.target.value)}
                  placeholder="username"
                  className="w-full rounded-2xl border border-white/10 bg-black/40 pl-8 pr-4 py-3 text-white outline-none transition-colors focus:border-purple-500/50"
                />
              </div>
              {fieldErrors.twitterHandle ? <p className="mt-2 text-xs text-red-300">{fieldErrors.twitterHandle}</p> : null}
            </label>

            <label className="block">
              <span className="mb-2 block text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500">
                Instagram Handle
              </span>
              <div className="relative">
                <span className="absolute left-4 top-3.5 text-zinc-500">@</span>
                <input
                  type="text"
                  value={form.instagramHandle || ''}
                  onChange={(event) => updateField('instagramHandle', event.target.value)}
                  placeholder="username"
                  className="w-full rounded-2xl border border-white/10 bg-black/40 pl-8 pr-4 py-3 text-white outline-none transition-colors focus:border-purple-500/50"
                />
              </div>
              {fieldErrors.instagramHandle ? <p className="mt-2 text-xs text-red-300">{fieldErrors.instagramHandle}</p> : null}
            </label>

            <label className="block md:col-span-2">
              <span className="mb-2 block text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500">
                TikTok Handle
              </span>
              <div className="relative">
                <span className="absolute left-4 top-3.5 text-zinc-500">@</span>
                <input
                  type="text"
                  value={form.tiktokHandle || ''}
                  onChange={(event) => updateField('tiktokHandle', event.target.value)}
                  placeholder="username"
                  className="w-full rounded-2xl border border-white/10 bg-black/40 pl-8 pr-4 py-3 text-white outline-none transition-colors focus:border-purple-500/50"
                />
              </div>
              {fieldErrors.tiktokHandle ? <p className="mt-2 text-xs text-red-300">{fieldErrors.tiktokHandle}</p> : null}
            </label>
          </div>
        </div>

        {/* Action Bar */}
        <div className="rounded-3xl border border-purple-500/20 bg-purple-900/10 p-6 backdrop-blur-md shadow-[0_0_40px_-15px_rgba(168,85,247,0.3)]">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="text-sm text-zinc-400">
              {form.credits !== null ? (
                <span><strong className="text-purple-300">{form.credits} credits</strong> available right now.</span>
              ) : (
                'Credits will update automatically from your account.'
              )}
            </div>
            <div className="flex flex-col items-start gap-2 sm:items-end">
              {formError ? <p className="text-sm text-red-300">{formError}</p> : null}
              {!formError && successMessage ? <p className="text-sm text-emerald-300">{successMessage}</p> : null}
              <button
                type="submit"
                disabled={isSaving || !normalizedUsername}
                className="inline-flex items-center gap-2 rounded-full bg-gradient-to-r from-purple-600 to-pink-600 px-8 py-3 text-sm font-semibold text-white shadow-[0_0_20px_-5px_rgba(168,85,247,0.5)] transition-all hover:scale-105 disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:scale-100"
              >
                {isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                Save Changes
              </button>
            </div>
          </div>
        </div>
      </form>
    </section>
  );
}
