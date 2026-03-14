# Motion Control API Documentation

> Generate content using the Motion Control model

## Overview

This document describes how to use the Motion Control model for content generation. The process consists of two steps:
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
| model | string | Yes | Model name, format: `kling-2.6/motion-control` |
| input | object | Yes | Input parameters object |
| callBackUrl | string | No | Callback URL for task completion notifications. If provided, the system will send POST requests to this URL when the task completes (success or fail). If not provided, no callback notifications will be sent. Example: `"https://your-domain.com/api/callback"` |

### Model Parameter

The `model` parameter specifies which AI model to use for content generation.

| Property | Value | Description |
|----------|-------|-------------|
| **Format** | `kling-2.6/motion-control` | The exact model identifier for this API |
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

#### prompt
- **Type**: `string`
- **Required**: No
- **Description**: A text description of the desired output. Maximum length is 2500 characters.
- **Max Length**: 2500 characters
- **Default Value**: `"The cartoon character is dancing."`

#### input_urls
- **Type**: `array`
- **Required**: Yes
- **Description**: Please provide the URL of the uploaded file,Reference image. The characters, backgrounds, and other elements in the generated video are based on the reference image. Supports .jpg/.jpeg/.png, max 10MB, size needs to be greater than 300px, aspect ratio 2:5 to 5:2.
- **Max File Size**: 10MB
- **Accepted File Types**: image/jpeg, image/png, image/jpg
- **Multiple Files**: Yes
- **Default Value**: `["https://static.aiquickdraw.com/tools/example/1767694885407_pObJoMcy.png"]`

#### video_urls
- **Type**: `array`
- **Required**: Yes
- **Description**: Please provide the URL of the uploaded file,Reference video. The character actions in the generated video are consistent with the reference video. Supports .mp4/.mov, max 100MB, 3-30 seconds duration depending on character_orientation.
- **Max File Size**: 100MB
- **Accepted File Types**: video/mp4, video/quicktime, video/x-matroska
- **Multiple Files**: Yes
- **Default Value**: `["https://static.aiquickdraw.com/tools/example/1767525918769_QyvTNib2.mp4"]`

#### character_orientation
- **Type**: `string`
- **Required**: Yes
- **Description**: Generate the orientation of the characters in the video. 'image': same orientation as the person in the picture (max 10s video). 'video': consistent with the orientation of the characters in the video (max 30s video).
- **Options**:
  - `image`: Image
  - `video`: Video
- **Default Value**: `"video"`

#### mode
- **Type**: `string`
- **Required**: Yes
- **Description**: Output resolution mode. Use 'std' for 720p or 'pro' for 1080p.
- **Options**:
  - `720p`: 720p
  - `1080p`: 1080p
- **Default Value**: `"720p"`

### Request Example

```json
{
  "model": "kling-2.6/motion-control",
  "input": {
    "prompt": "The cartoon character is dancing.",
    "input_urls": ["https://static.aiquickdraw.com/tools/example/1767694885407_pObJoMcy.png"],
    "video_urls": ["https://static.aiquickdraw.com/tools/example/1767525918769_QyvTNib2.mp4"],
    "character_orientation": "video",
    "mode": "720p"
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
    "model": "kling-2.6/motion-control",
    "state": "waiting",
    "param": "{\"model\":\"kling-2.6/motion-control\",\"input\":{\"prompt\":\"The cartoon character is dancing.\",\"input_urls\":[\"https://static.aiquickdraw.com/tools/example/1767694885407_pObJoMcy.png\"],\"video_urls\":[\"https://static.aiquickdraw.com/tools/example/1767525918769_QyvTNib2.mp4\"],\"character_orientation\":\"video\",\"mode\":\"720p\"}}",
    "resultJson": "{\"resultUrls\":[\"https://static.aiquickdraw.com/tools/example/1767525938144_1MAbktBM.mp4\"]}",
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

