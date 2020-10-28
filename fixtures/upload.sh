BUCKET=$1
ASSETID=$(date +%s)
SLEEP=2
export AWS_PAGER=""
aws s3 cp image.jpg s3://$BUCKET/$ASSETID/image.jpg
sleep $SLEEP
aws s3 cp video.mp4 s3://$BUCKET/$ASSETID/video.mp4
sleep $SLEEP
aws s3 cp manifest.json s3://$BUCKET/$ASSETID/manifest.json
sleep $SLEEP
aws s3 cp metadata.json s3://$BUCKET/$ASSETID/metadata.json
