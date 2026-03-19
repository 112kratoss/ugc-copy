# Sound Effect V2 API Documentation

> Generate content using the Sound Effect V2 model

## Overview

This document describes how to use the Sound Effect V2 model for content generation. The process consists of two steps:
1. Create a generation task
2. Query task status and results

## Authentication

All API requests require a Bearer Token in the request header:

```
Authorization: Bearer YOUR_API_KEY
```

Get API Key:
1. Visit [API Key Management Page](https://kie.ai/api-key) to get your API Key
2. Add to request header: `Authorization: Bearer YOUR_API_KEY`

---

## 1. Create Generation Task

### API Information
- **URL**: `POST https://api.kie.ai/api/v1/jobs/createTask`
- **Content-Type**: `application/json`

### Request Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| model | string | Yes | Model name, format: `elevenlabs/sound-effect-v2` |
| input | object | Yes | Input parameters object |
| callBackUrl | string | No | Callback URL for task completion notifications. If provided, the system will send POST requests to this URL when the task completes (success or fail). If not provided, no callback notifications will be sent. Example: `"https://your-domain.com/api/callback"` |

### Model Parameter

The `model` parameter specifies which AI model to use for content generation.

| Property | Value | Description |
|----------|-------|-------------|
| **Format** | `elevenlabs/sound-effect-v2` | The exact model identifier for this API |
| **Type** | string | Must be passed as a string value |
| **Required** | Yes | This parameter is mandatory for all requests |

> **Note**: The model parameter must match exactly as shown above. Different models have different capabilities and parameter requirements.

### Callback URL Parameter

The `callBackUrl` parameter allows you to receive automatic notifications when your task completes.

| Property | Value | Description |
|----------|-------|-------------|
| **Purpose** | Task completion notification | Receive real-time updates when your task finishes |
| **Method** | POST request | The system sends POST requests to your callback URL |
| **Timing** | When task completes | Notifications sent for both success and failure states |
| **Content** | Query Task API response | Callback content structure is identical to the Query Task API response |
| **Parameters** | Complete request data | The `param` field contains the complete Create Task request parameters, not just the input section |
| **Optional** | Yes | If not provided, no callback notifications will be sent |

**Important Notes:**
- The callback content structure is identical to the Query Task API response
- The `param` field contains the complete Create Task request parameters, not just the input section  
- If `callBackUrl` is not provided, no callback notifications will be sent

### input Object Parameters

#### text
- **Type**: `string`
- **Required**: Yes
- **Description**: The text describing the sound effect to generate
- **Max Length**: 450 characters
- **Default Value**: `""`

#### loop
- **Type**: `boolean`
- **Required**: No
- **Description**: Whether to create a sound effect that loops smoothly
- **Default Value**: `false`

#### duration_seconds
- **Type**: `number`
- **Required**: No
- **Description**: Duration in seconds (0.5-22). If None, optimal duration will be determined from prompt
- **Range**: 0.5 - 22 (step: 0.1)

#### prompt_influence
- **Type**: `number`
- **Required**: No
- **Description**: How closely to follow the prompt (0-1). Higher values mean less variation
- **Range**: 0 - 1 (step: 0.01)
- **Default Value**: `0.3`

#### output_format
- **Type**: `string`
- **Required**: No
- **Description**: Output format of the generated audio. Formatted as codec_sample_rate_bitrate
- **Options**:
  - `mp3_22050_32`: MP3 22050Hz 32kbps
  - `mp3_44100_32`: MP3 44100Hz 32kbps
  - `mp3_44100_64`: MP3 44100Hz 64kbps
  - `mp3_44100_96`: MP3 44100Hz 96kbps
  - `mp3_44100_128`: MP3 44100Hz 128kbps
  - `mp3_44100_192`: MP3 44100Hz 192kbps
  - `pcm_8000`: PCM 8000Hz
  - `pcm_16000`: PCM 16000Hz
  - `pcm_22050`: PCM 22050Hz
  - `pcm_24000`: PCM 24000Hz
  - `pcm_44100`: PCM 44100Hz
  - `pcm_48000`: PCM 48000Hz
  - `ulaw_8000`: μ-law 8000Hz
  - `alaw_8000`: A-law 8000Hz
  - `opus_48000_32`: Opus 48000Hz 32kbps
  - `opus_48000_64`: Opus 48000Hz 64kbps
  - `opus_48000_96`: Opus 48000Hz 96kbps
  - `opus_48000_128`: Opus 48000Hz 128kbps
  - `opus_48000_192`: Opus 48000Hz 192kbps
- **Default Value**: `"mp3_44100_128"`

### Request Example

```json
{
  "model": "elevenlabs/sound-effect-v2",
  "input": {
    "text": "Enter your prompt here...",
    "loop": false,
    "duration_seconds": 42,
    "prompt_influence": 0.3,
    "output_format": "mp3_44100_128"
  }
}
```
### Response Example

```json
{
  "code": 200,
  "msg": "success",
  "data": {
    "taskId": "281e5b0*********************f39b9"
  }
}
```

### Response Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| code | integer | Response status code, 200 indicates success |
| msg | string | Response message |
| data.taskId | string | Task ID for querying task status |

---

## 2. Query Task Status

### API Information
- **URL**: `GET https://api.kie.ai/api/v1/jobs/recordInfo`
- **Parameter**: `taskId` (passed via URL parameter)

### Request Example
```
GET https://api.kie.ai/api/v1/jobs/recordInfo?taskId=281e5b0*********************f39b9
```

### Response Example

```json
{
  "code": 200,
  "msg": "success",
  "data": {
    "taskId": "281e5b0*********************f39b9",
    "model": "elevenlabs/sound-effect-v2",
    "state": "waiting",
    "param": "{\"model\":\"elevenlabs/sound-effect-v2\",\"input\":{\"text\":\"Enter your prompt here...\",\"loop\":false,\"duration_seconds\":42,\"prompt_influence\":0.3,\"output_format\":\"mp3_44100_128\"}}",
    "resultJson": "",
    "failCode": null,
    "failMsg": null,
    "costTime": null,
    "completeTime": null,
    "createTime": 1757584164490
  }
}
```

### Response Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| code | integer | Response status code, 200 indicates success |
| msg | string | Response message |
| data.taskId | string | Task ID |
| data.model | string | Model name used |
| data.state | string | Task status: `waiting`(waiting),  `success`(success), `fail`(fail) |
| data.param | string | Task parameters (JSON string) |
| data.resultJson | string | Task result (JSON string, available when task is success). Structure depends on outputMediaType: `{resultUrls: []}` for image/media/video, `{resultObject: {}}` for text |
| data.failCode | string | Failure code (available when task fails) |
| data.failMsg | string | Failure message (available when task fails) |
| data.costTime | integer | Task duration in milliseconds (available when task is success) |
| data.completeTime | integer | Completion timestamp (available when task is success) |
| data.createTime | integer | Creation timestamp |

---

## Usage Flow

1. **Create Task**: Call `POST https://api.kie.ai/api/v1/jobs/createTask` to create a generation task
2. **Get Task ID**: Extract `taskId` from the response
3. **Wait for Results**: 
   - If you provided a `callBackUrl`, wait for the callback notification
   - If no `callBackUrl`, poll status by calling `GET https://api.kie.ai/api/v1/jobs/recordInfo`
4. **Get Results**: When `state` is `success`, extract generation results from `resultJson`

## Error Codes

| Status Code | Description |
|-------------|-------------|
| 200 | Request successful |
| 400 | Invalid request parameters |
| 401 | Authentication failed, please check API Key |
| 402 | Insufficient account balance |
| 404 | Resource not found |
| 422 | Parameter validation failed |
| 429 | Request rate limit exceeded |
| 500 | Internal server error |

Pricing: Pricing: ElevenLabs Sound Effect V2 on Kie.ai costs just 0.24 credits per second (≈ $0.0012) — just 14 credits per minute.
