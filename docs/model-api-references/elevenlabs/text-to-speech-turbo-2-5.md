# ElevenLabs Text-to-Speech Turbo 2.5 API Documentation

> Generate low-latency voice audio using the ElevenLabs Text-to-Speech Turbo 2.5 model

## Overview

This document describes how to use the ElevenLabs Text-to-Speech Turbo 2.5 model for voice generation. The process consists of two steps:
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
| model | string | Yes | Model name, format: `elevenlabs/text-to-speech-turbo-2-5` |
| input | object | Yes | Input parameters object |
| callBackUrl | string | No | Callback URL for task completion notifications. If provided, the system will send POST requests to this URL when the task completes. Example: `"https://your-domain.com/api/callback"` |

### Model Parameter

The `model` parameter specifies which AI model to use for content generation.

| Property | Value | Description |
|----------|-------|-------------|
| **Format** | `elevenlabs/text-to-speech-turbo-2-5` | The exact model identifier for this API |
| **Type** | string | Must be passed as a string value |
| **Required** | Yes | This parameter is mandatory for all requests |

### Callback URL Parameter

The `callBackUrl` parameter allows you to receive automatic notifications when your task completes.

| Property | Value | Description |
|----------|-------|-------------|
| **Purpose** | Task completion notification | Receive real-time updates when your task finishes |
| **Method** | POST request | The system sends POST requests to your callback URL |
| **Timing** | When task completes | Notifications are sent when generation finishes |
| **Content** | Task status and result payload | Callback content includes task information and generation output |
| **Optional** | Yes | If not provided, poll the task status endpoint manually |

### input Object Parameters

#### text
- **Type**: `string`
- **Required**: Yes
- **Description**: The text to convert to speech.
- **Max Length**: 5000 characters
- **Example Value**: `"Unlock powerful API with Kie.ai! Affordable, scalable APl integration, free trial playground, and secure, reliable performance."`

#### voice
- **Type**: `string`
- **Required**: No
- **Description**: The voice to use for speech generation. You can pass a preset voice name or a supported voice ID. KIE exposes a large catalog of voices; common examples include `Rachel`, `Adam`, and `Brian`. Voice previews follow the pattern `https://static.aiquickdraw.com/elevenlabs/voice/<voice_id>.mp3`.
- **Default Value**: `Rachel`

#### stability
- **Type**: `number`
- **Required**: No
- **Description**: Voice stability.
- **Range**: `0` to `1`
- **Default Value**: `0.5`

#### similarity_boost
- **Type**: `number`
- **Required**: No
- **Description**: Similarity boost for closer adherence to the selected voice.
- **Range**: `0` to `1`
- **Default Value**: `0.75`

#### style
- **Type**: `number`
- **Required**: No
- **Description**: Style exaggeration.
- **Range**: `0` to `1`
- **Default Value**: `0`

#### speed
- **Type**: `number`
- **Required**: No
- **Description**: Speech speed. Values below `1.0` slow down the speech; values above `1.0` speed it up.
- **Range**: `0.7` to `1.2`
- **Default Value**: `1`

#### timestamps
- **Type**: `boolean`
- **Required**: No
- **Description**: Whether to return timestamps for each word in the generated speech.
- **Default Value**: `false`

#### previous_text
- **Type**: `string`
- **Required**: No
- **Description**: Text that comes before the current segment. Useful for continuity across multiple generations.
- **Max Length**: 5000 characters

#### next_text
- **Type**: `string`
- **Required**: No
- **Description**: Text that comes after the current segment. Useful for continuity across multiple generations.
- **Max Length**: 5000 characters

#### language_code
- **Type**: `string`
- **Required**: No
- **Description**: Optional ISO 639-1 language code used to enforce a language for this model.
- **Max Length**: 500 characters

### Request Example

```json
{
  "model": "elevenlabs/text-to-speech-turbo-2-5",
  "callBackUrl": "https://your-domain.com/api/callback",
  "input": {
    "text": "Unlock powerful API with Kie.ai! Affordable, scalable APl integration, free trial playground, and secure, reliable performance.",
    "voice": "Rachel",
    "stability": 0.5,
    "similarity_boost": 0.75,
    "style": 0,
    "speed": 1,
    "timestamps": false,
    "previous_text": "",
    "next_text": "",
    "language_code": ""
  }
}
```

### Response Example

```json
{
  "code": 200,
  "msg": "success",
  "data": {
    "taskId": "task_elevenlabs_1765185518880",
    "recordId": "elevenlabs_1765185518880"
  }
}
```

### Response Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| code | integer | Response status code |
| msg | string | Response message |
| data.taskId | string | Task ID for querying task status |
| data.recordId | string | Provider-side record ID |

---

## 2. Query Task Status

### API Information
- **URL**: `GET https://api.kie.ai/api/v1/jobs/recordInfo`
- **Parameter**: `taskId` (passed via URL parameter)

This is KIE's unified Market query endpoint and works for ElevenLabs tasks as well.

### Request Example

```
GET https://api.kie.ai/api/v1/jobs/recordInfo?taskId=task_elevenlabs_1765185518880
```

### Response Example

```json
{
  "code": 200,
  "msg": "success",
  "data": {
    "taskId": "task_elevenlabs_1765185518880",
    "model": "elevenlabs/text-to-speech-turbo-2-5",
    "state": "success",
    "param": "{\"model\":\"elevenlabs/text-to-speech-turbo-2-5\",\"input\":{...}}",
    "resultJson": "{...}",
    "failCode": "",
    "failMsg": "",
    "costTime": 15000,
    "completeTime": 1698765432000,
    "createTime": 1698765400000,
    "updateTime": 1698765432000
  }
}
```

### Response Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| code | integer | Response status code |
| msg | string | Response message |
| data.taskId | string | Task ID |
| data.model | string | Model name used |
| data.state | string | Task status: `waiting`, `queuing`, `generating`, `success`, or `fail` |
| data.param | string | Serialized task parameters |
| data.resultJson | string | Serialized result payload returned by the model |
| data.failCode | string | Failure code when the task fails |
| data.failMsg | string | Failure message when the task fails |
| data.costTime | integer | Task duration in milliseconds |
| data.completeTime | integer | Completion timestamp |
| data.createTime | integer | Creation timestamp |
| data.updateTime | integer | Last update timestamp |

---

## Usage Flow

1. **Create Task**: Call `POST https://api.kie.ai/api/v1/jobs/createTask` to create a speech generation task
2. **Get Task ID**: Extract `taskId` from the response
3. **Wait for Results**:
   - If you provided a `callBackUrl`, wait for the callback notification
   - If no `callBackUrl`, poll status by calling `GET https://api.kie.ai/api/v1/jobs/recordInfo`
4. **Get Results**: When `state` is `success`, parse `resultJson` to retrieve the generated speech payload

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
| 455 | Service unavailable / maintenance |
| 500 | Internal server error |
| 501 | Generation failed |
| 505 | Feature disabled |


Pricing: ElevenLabs TTS Turbo V2.5: 6 credits per 1,000 characters (≈ $0.03).