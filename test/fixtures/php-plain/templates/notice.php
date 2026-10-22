<?php
/**
 * Notice banner template.
 *
 * @var array $args {
 *     @type string $message Text to show.
 *     @type string $type    'info' or 'warning'. Default 'info'.
 * }
 */

$message = $args['message'] ?? '';
$type    = $args['type'] ?? 'info';
$dismiss = $args['dismissible'] ?? false;
?>
<div class="notice notice-<?php echo $type; ?>"><?php echo $message; ?></div>
