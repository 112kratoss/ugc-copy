require 'xcodeproj'
root, controller = ARGV
project = Xcodeproj::Project.new(File.join(root, 'LoopProbe.xcodeproj'))
target = project.new_target(:application, 'LoopProbe', :ios, '18.0')
target.add_file_references([project.main_group.new_reference(File.join(root, 'Probe.swift')),
  project.main_group.new_reference(controller)])
target.resources_build_phase.add_file_reference(project.main_group.new_reference(File.join(root, 'loop.mp4')))
target.build_configurations.each do |config|
  config.build_settings.merge!({
    'PRODUCT_BUNDLE_IDENTIFIER' => 'com.athuls.magicbooklet.loopprobe',
    'PRODUCT_NAME' => 'LoopProbe', 'DEVELOPMENT_TEAM' => 'HNA8393NT4',
    'CODE_SIGN_STYLE' => 'Automatic', 'GENERATE_INFOPLIST_FILE' => 'YES',
    'SWIFT_VERSION' => '5.0', 'IPHONEOS_DEPLOYMENT_TARGET' => '18.0',
    'TARGETED_DEVICE_FAMILY' => '1', 'CURRENT_PROJECT_VERSION' => '1',
    'MARKETING_VERSION' => '1.0', 'INFOPLIST_KEY_UILaunchScreen_Generation' => 'YES',
    'INFOPLIST_KEY_UISupportedInterfaceOrientations' => 'UIInterfaceOrientationPortrait'
  })
end
project.save
scheme = Xcodeproj::XCScheme.new
scheme.add_build_target(target)
scheme.set_launch_target(target)
scheme.save_as(project.path, 'LoopProbe', true)
