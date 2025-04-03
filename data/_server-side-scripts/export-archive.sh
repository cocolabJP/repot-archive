#!/bin/bash

target_list=()
while read LINE
do
        target_list+=(${LINE})
done < './archive-list.txt'

echo ${target_list[@]}

for target in ${target_list[@]}
do
        echo ${target}
        echo `sh sql-export-repots-by-hashtag.sh ${target}`
done

echo `sh sql-export-hashtags.sh`