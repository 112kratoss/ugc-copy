# ElevenLabs Text-to-Dialogue v3 API Documentation

> Generate multi-speaker voice dialogue using the ElevenLabs Text-to-Dialogue v3 model

## Overview

This document describes how to use the ElevenLabs Text-to-Dialogue v3 model for voice generation. The process consists of two steps:
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
| model | string | Yes | Model name, format: `elevenlabs/text-to-dialogue-v3` |
| input | object | Yes | Input parameters object |
| callBackUrl | string | No | Callback URL for task completion notifications. If provided, the system will send POST requests to this URL when the task completes. Example: `"https://your-domain.com/api/callback"` |

### Model Parameter

The `model` parameter specifies which AI model to use for content generation.

| Property | Value | Description |
|----------|-------|-------------|
| **Format** | `elevenlabs/text-to-dialogue-v3` | The exact model identifier for this API |
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

#### dialogue
- **Type**: `array<object>`
- **Required**: Yes
- **Description**: Array of dialogue items. Each item contains a `text` field and a `voice` field. The total character count of all `text` values combined must not exceed 5000 characters.
- **Example Value**:

```json
[
  { "text": "I have a pen, I have an apple, ah, Apple pen~", "voice": "Adam" },
  { "text": "a happy dog", "voice": "Brian" },
  { "text": "a happy cat", "voice": "Roger" }
]
```

#### dialogue[] Object Shape

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| text | string | Yes | Spoken line for this dialogue turn |
| voice | string | Yes | Voice name for this dialogue turn, such as `Adam`, `Brian`, or `Roger` |

#### stability
- **Type**: `number`
- **Required**: No
- **Description**: Voice stability parameter.
- **Allowed Values**: `0`, `0.5`, `1`
- **Default Value**: `0.5`

#### language_code
- **Type**: `string`
- **Required**: No
- **Description**: Language code for the generated speech. Leave empty or omit the field for automatic language detection.
- **Allowed Values**: `af`, `ar`, `hy`, `as`, `az`, `be`, `bn`, `bs`, `bg`, `ca`, `ceb`, `ny`, `hr`, `cs`, `da`, `nl`, `en`, `et`, `fil`, `fi`, `fr`, `gl`, `ka`, `de`, `el`, `gu`, `ha`, `he`, `hi`, `hu`, `is`, `id`, `ga`, `it`, `ja`, `jv`, `kn`, `kk`, `ky`, `ko`, `lv`, `ln`, `lt`, `lb`, `mk`, `ms`, `ml`, `zh`, `mr`, `ne`, `no`, `ps`, `fa`, `pl`, `pt`, `pa`, `ro`, `ru`, `sr`, `sd`, `sk`, `sl`, `so`, `es`, `sw`, `sv`, `ta`, `te`, `th`, `tr`, `uk`, `ur`, `vi`, `cy`

### Request Example

```json
{
  "model": "elevenlabs/text-to-dialogue-v3",
  "callBackUrl": "https://your-domain.com/api/callback",
  "input": {
    "dialogue": [
      {
        "text": "I have a pen, I have an apple, ah, Apple pen~",
        "voice": "Adam"
      },
      {
        "text": "a happy dog",
        "voice": "Brian"
      },
      {
        "text": "a happy cat",
        "voice": "Roger"
      }
    ],
    "stability": 0.5
  }
}
```

### Response Example

```json
{
  "code": 200,
  "msg": "success",
  "data": {
    "taskId": "task_elevenlabs_1765185448724",
    "recordId": "elevenlabs_1765185448724"
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
GET https://api.kie.ai/api/v1/jobs/recordInfo?taskId=task_elevenlabs_1765185448724
```

### Response Example

```json
{
  "code": 200,
  "msg": "success",
  "data": {
    "taskId": "task_elevenlabs_1765185448724",
    "model": "elevenlabs/text-to-dialogue-v3",
    "state": "success",
    "param": "{\"model\":\"elevenlabs/text-to-dialogue-v3\",\"input\":{...}}",
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

1. **Create Task**: Call `POST https://api.kie.ai/api/v1/jobs/createTask` to create a dialogue generation task
2. **Get Task ID**: Extract `taskId` from the response
3. **Wait for Results**:
   - If you provided a `callBackUrl`, wait for the callback notification
   - If no `callBackUrl`, poll status by calling `GET https://api.kie.ai/api/v1/jobs/recordInfo`
4. **Get Results**: When `state` is `success`, parse `resultJson` to retrieve the generated dialogue audio payload

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


Pricing: ElevenLabs Text-to-Speech V3: 14 credits per 1,000 characters (≈ $0.07)